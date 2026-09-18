#!/usr/bin/env python3
"""Synchronize Pi's model list from an OpenAI-compatible server.

Usage:
    .pi/agent/extensions/sync-models.py
    .pi/agent/extensions/sync-models.py --include-all
    .pi/agent/extensions/sync-models.py --api-key KEY --ip 192.168.1.10 --port 8888
    .pi/agent/extensions/sync-models.py --config /path/to/models.json

The existing provider configuration is preserved. Existing model entries keep
their Pi-specific metadata; new entries receive sensible defaults based on
the server's /v1/models response. Missing configuration is created
interactively.

GGUF models with more than one downloaded quantization get one entry per
quant, addressed as "<model id>:<quant>" (e.g.
"unsloth/Qwen3.8-27B-GGUF:UD-Q8_K_XL"). With Studio's OpenAI auto-switch
enabled, requesting such an id loads/switches to that quantization.
Models with a single quant keep their plain id.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen


DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "models.json"
DEFAULT_CONTEXT = 128_000
DEFAULT_MAX_TOKENS = 32_000
DEFAULT_PORT = 8888


def fetch_models(base_url: str, api_key: str) -> list[dict]:
    url = base_url.rstrip("/") + "/models"
    request = Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"server returned HTTP {exc.code} for {url}") from exc
    except URLError as exc:
        raise RuntimeError(f"could not connect to {url}: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"server returned invalid JSON from {url}") from exc

    models = payload.get("data")
    if not isinstance(models, list):
        raise RuntimeError("model response does not contain a 'data' list")
    return [model for model in models if isinstance(model, dict) and model.get("id")]


# Studio tags non-LLM models with a `task` field (e.g. Z-Image-Turbo-GGUF is
# "text-to-image"); chat models have no task or a plain text-generation one.
CHAT_TASKS = {None, "text-generation", "chat", "completion"}


def is_non_chat(model: dict) -> bool:
    return model.get("task") not in CHAT_TASKS


def is_embedding(model: dict) -> bool:
    haystack = " ".join(
        str(model.get(field, "")) for field in ("id", "display_name", "owned_by")
    ).lower()
    return "embedding" in haystack or "embed" in haystack


def context_window(model: dict) -> int:
    # Prefer the native limit, then the advertised maximum/current limit.
    for field in ("native_context_length", "max_context_length", "context_length"):
        value = model.get(field)
        if isinstance(value, int) and value > 0:
            return value
    return DEFAULT_CONTEXT


def fetch_quant_variants(base_url: str, api_key: str, model_id: str) -> list[str]:
    """Return the downloaded GGUF quantizations for a model repo (best effort).

    Uses Studio's /api/models/gguf-variants endpoint with
    prefer_local_cache=true: the network-resolved listing reports multi-part GGUF
    repos (e.g. Qwen3.8-Flash-Next) as never downloaded even with every shard on
    disk, and this flag answers from the local cache instead. The endpoint lives
    on the server root rather than under the /v1 base path. Returns [] when it is
    unavailable or the repo has no variant list.
    """
    parts = urlsplit(base_url.rstrip("/"))
    root = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    url = (
        f"{root}/api/models/gguf-variants"
        f"?repo_id={quote(model_id, safe='')}&prefer_local_cache=true"
    )
    request = Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.load(response)
    except (HTTPError, URLError, json.JSONDecodeError):
        return []
    variants = payload.get("variants") if isinstance(payload, dict) else None
    if not isinstance(variants, list):
        return []
    quants: list[str] = []
    for variant in variants:
        if not isinstance(variant, dict) or not variant.get("downloaded"):
            continue
        quant = variant.get("quant")
        if isinstance(quant, str) and quant not in quants:
            quants.append(quant)
    return quants


def derive_name(model_id: str) -> str:
    name = model_id.split("/")[-1]
    if name.upper().endswith("-GGUF"):
        name = name[: -len("-GGUF")]
    return name.replace("-", " ")


def make_entry(
    model_id: str,
    old_by_id: dict[str, dict],
    server_model: dict | None = None,
    base_model_id: str | None = None,
    quant: str | None = None,
) -> dict:
    # Inherit metadata from an entry with the exact id first, then from the
    # base model entry (so plain-id config carries over to quant-suffixed ids).
    old = old_by_id.get(model_id)
    if old is None and base_model_id:
        old = old_by_id.get(base_model_id)
    old = dict(old or {})
    server_model = server_model or {}
    entry = dict(old)
    entry["id"] = model_id
    entry.setdefault("reasoning", False)
    entry.setdefault("input", ["text"])
    entry.setdefault("contextWindow", context_window(server_model))
    entry.setdefault("maxTokens", DEFAULT_MAX_TOKENS)
    entry.setdefault(
        "cost",
        {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    )
    if "qwen3.8" in model_id.lower():
        entry["reasoning"] = True
        entry["thinkingLevelMap"] = {
            "off": "none",
            "minimal": "minimal",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
        }
        compat = dict(entry.get("compat") or {})
        compat["thinkingFormat"] = "qwen"
        entry["compat"] = compat
        sampling_params = dict(entry.get("samplingParams") or {})
        chat_template_kwargs = dict(
            sampling_params.get("chat_template_kwargs") or {}
        )
        chat_template_kwargs["preserve_thinking"] = True
        sampling_params["chat_template_kwargs"] = chat_template_kwargs
        entry["samplingParams"] = sampling_params
    if quant:
        base_name = old.get("name") or derive_name(base_model_id or model_id)
        # Drop any stale "(quant)" suffix left over from a previous sync.
        base_name = re.sub(r"\s*\([^)]*\)$", "", str(base_name)).strip()
        entry["name"] = f"{base_name} ({quant})"
    return entry


def write_json_atomically(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, indent=2)
            output.write("\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def prompt_value(label: str, default: str | None = None, secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    try:
        value = getpass.getpass(f"{label}{suffix}: ") if secret else input(f"{label}{suffix}: ")
    except (EOFError, KeyboardInterrupt) as exc:
        raise RuntimeError(f"{label} is required") from exc
    value = value.strip() or (default or "")
    if not value:
        raise RuntimeError(f"{label} is required")
    return value


def load_config(path: Path) -> dict:
    if not path.exists():
        return {"providers": {}}
    with path.open(encoding="utf-8") as source:
        config = json.load(source)
    if not isinstance(config, dict):
        raise RuntimeError("models config must contain a JSON object")
    return config


def configure_provider(config: dict, args: argparse.Namespace) -> tuple[str, dict, str, str]:
    providers = config.setdefault("providers", {})
    if not isinstance(providers, dict):
        raise RuntimeError("models config 'providers' must be an object")

    if len(providers) > 1:
        raise RuntimeError("expected at most one provider in the config")

    if providers:
        provider_name, provider = next(iter(providers.items()))
        if not isinstance(provider, dict):
            raise RuntimeError(f"provider '{provider_name}' must be an object")
    else:
        provider_name = args.provider_name or prompt_value("Provider name")
        provider = {
            "api": "openai-completions",
            "compat": {
                "supportsDeveloperRole": False,
                "supportsReasoningEffort": True,
            },
            "models": [],
        }
        providers[provider_name] = provider

    base_url = provider.get("baseUrl")
    parsed = urlsplit(base_url) if isinstance(base_url, str) and base_url else None
    hostname = args.ip or (parsed.hostname if parsed else None)
    port = args.port or (parsed.port if parsed else None)

    if not hostname:
        hostname = prompt_value("Server IP or hostname")
    if port is None:
        port_text = prompt_value("Server port", str(DEFAULT_PORT))
        try:
            port = int(port_text)
        except ValueError as exc:
            raise RuntimeError("Server port must be an integer") from exc
    if not 1 <= port <= 65535:
        raise RuntimeError("Server port must be between 1 and 65535")

    scheme = parsed.scheme if parsed else "http"
    path = parsed.path if parsed and parsed.path else "/v1"
    base_url = urlunsplit((scheme, f"{hostname}:{port}", path, "", ""))

    api_key = args.api_key or provider.get("apiKey")
    if not isinstance(api_key, str) or not api_key:
        api_key = prompt_value("API key", secret=True)

    provider["baseUrl"] = base_url
    provider["apiKey"] = api_key
    return provider_name, provider, base_url, api_key


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--api-key", help="override the API key from models.json")
    parser.add_argument("--ip", help="override the Unsloth server IP/hostname")
    parser.add_argument("--port", type=int, help="override the Unsloth server port")
    parser.add_argument("--provider-name", help="provider name when creating models.json")
    parser.add_argument(
        "--include-all",
        action="store_true",
        help="include embedding models as well as chat/completion models",
    )
    args = parser.parse_args()

    try:
        config = load_config(args.config)
        provider_name, provider, base_url, api_key = configure_provider(config, args)
        write_json_atomically(args.config, config)

        server_models = fetch_models(base_url, api_key)
        server_models = [model for model in server_models if not is_non_chat(model)]
        if not args.include_all:
            server_models = [model for model in server_models if not is_embedding(model)]
        if not server_models:
            raise RuntimeError("server returned no usable models; refusing to overwrite config")

        old_models = provider.get("models", [])
        old_by_id = {
            model["id"]: model
            for model in old_models
            if isinstance(model, dict) and model.get("id")
        }

        entries: list[dict] = []
        for model in server_models:
            model_id = model["id"]
            quants: list[str] = []
            if isinstance(model_id, str) and model_id.upper().endswith("-GGUF"):
                quants = fetch_quant_variants(base_url, api_key, model_id)
                loaded = model.get("quant")
                # Keep the currently loaded quant first so the default
                # position matches what the server has in memory.
                if isinstance(loaded, str) and loaded in quants:
                    quants.remove(loaded)
                    quants.insert(0, loaded)
            if len(quants) > 1:
                for quant in quants:
                    entries.append(
                        make_entry(
                            f"{model_id}:{quant}",
                            old_by_id,
                            model,
                            base_model_id=model_id,
                            quant=quant,
                        )
                    )
            else:
                entries.append(make_entry(model_id, old_by_id, model))
        provider["models"] = entries
        write_json_atomically(args.config, config)

        print(f"Synchronized {len(provider['models'])} models in {args.config}")
        for model in provider["models"]:
            print(f"  {model['id']}")
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"sync-models: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

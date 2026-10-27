#!/usr/bin/env python3
"""Call iFinD through agent-gw data source tools."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

DATA_SOURCE_NAME = "ifind"
DEFAULT_TIMEOUT = 60.0


def _client_cls():
    try:
        from agent_gw import AgentGwClient, AgentGwError
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency: agent-gw. Install it with: "
            'python3 -m pip install "$(curl -s https://cdn.kimi.com/agentgw/pysdk/manifest.json | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"latest\").get(\"url\"))")"'
        ) from exc
    return AgentGwClient, AgentGwError


def _json_obj(text: str) -> Dict[str, Any]:
    data = json.loads(text)
    if not isinstance(data, dict):
        raise argparse.ArgumentTypeError("JSON value must be an object")
    return data


def _load_params(args: argparse.Namespace) -> Dict[str, Any]:
    if args.params_json and args.params_file:
        raise SystemExit("Use only one of --params-json or --params-file")
    if args.params_file:
        return _json_obj(Path(args.params_file).read_text(encoding="utf-8"))
    if args.params_json:
        return _json_obj(args.params_json)
    return {}


def _texts(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if value is None:
        return []
    return [str(value)]


def describe(args: argparse.Namespace) -> int:
    agent_gw_client, agent_gw_error = _client_cls()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            resp = client.tools.get_data_source_desc({"name": args.data_source})
            resp.raise_for_status()
            print(resp.text)
    except agent_gw_error as exc:
        print(f"Error describing data source '{args.data_source}': {exc}", file=sys.stderr)
        return 1
    return 0


def call(args: argparse.Namespace) -> int:
    api_params = _load_params(args)
    payload = {
        "data_source_name": args.data_source,
        "api_name": args.api_name,
        "params": api_params,
    }

    agent_gw_client, agent_gw_error = _client_cls()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            resp = client.tools.call_data_source_tool(payload)
    except agent_gw_error as exc:
        print(
            f"Error calling API '{args.api_name}' from data source '{args.data_source}': {exc}",
            file=sys.stderr,
        )
        return 1
    raw = resp.raw

    if not raw.get("is_success"):
        error = raw.get("error") or {}
        assistant_errors = _texts(error.get("assistant") if isinstance(error, dict) else None)
        user_errors = _texts(error.get("user") if isinstance(error, dict) else None)
        message = "\n".join(user_errors or assistant_errors)
        if not message:
            message = f"Error calling API '{args.api_name}' from data source '{args.data_source}'"
        print(message, file=sys.stderr)
        return 1

    for file_info in raw.get("files") or []:
        if not isinstance(file_info, dict) or not file_info.get("name"):
            continue
        path = Path(str(file_info["name"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(file_info.get("content", "")), encoding="utf-8")

    result = raw.get("result") or {}
    assistant_texts = _texts(result.get("assistant") if isinstance(result, dict) else None)
    print("\n".join(assistant_texts))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    describe_parser = subparsers.add_parser("describe", help="Print iFinD Markdown docs")
    describe_parser.add_argument("--data-source", default=DATA_SOURCE_NAME)
    describe_parser.set_defaults(func=describe)

    call_parser = subparsers.add_parser("call", help="Call an iFinD API")
    call_parser.add_argument("--data-source", default=DATA_SOURCE_NAME)
    call_parser.add_argument("--api-name", required=True)
    call_parser.add_argument("--params-json", help="API params as a JSON object")
    call_parser.add_argument("--params-file", help="Path to a JSON object with API params")
    call_parser.set_defaults(func=call)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

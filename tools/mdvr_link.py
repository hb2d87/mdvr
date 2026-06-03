#!/usr/bin/env python3
"""Public MDVR link helper."""

try:
    from tools.ows_link import (
        DEFAULT_BASE_URL,
        build_hash_url,
        build_markdown_link,
        build_path_url,
        build_query_url,
        build_url,
        main,
        normalize_path,
    )
except ModuleNotFoundError:
    from ows_link import (  # type: ignore[no-redef]
        DEFAULT_BASE_URL,
        build_hash_url,
        build_markdown_link,
        build_path_url,
        build_query_url,
        build_url,
        main,
        normalize_path,
    )

__all__ = [
    "DEFAULT_BASE_URL",
    "build_hash_url",
    "build_markdown_link",
    "build_path_url",
    "build_query_url",
    "build_url",
    "normalize_path",
]


if __name__ == "__main__":
    main()

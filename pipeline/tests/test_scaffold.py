"""Prove the scaffold itself: the frozen sync installed the package."""

from importlib.metadata import version

import clipper


def test_package_is_installed() -> None:
    assert version("clipper") == "0.1.0"


def test_package_documents_its_governing_docs() -> None:
    assert clipper.__doc__ is not None
    assert "pipeline-architecture.md" in clipper.__doc__

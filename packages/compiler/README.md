# `@neurcode-ai/share-compiler`

Experimental, deterministic, local context selection for Neurcode Share.

The package reads a concrete Git change and returns existing Neurcode CLI
selection strings plus an explainable coverage plan. It writes no repository
files, makes no network calls, constructs no Share document, and has no runtime
dependencies. Capture, scanning, disclosure review, archive creation, and
validation remain the responsibility of the existing CLI and Share Format.

This package is a bounded technical experiment. It is not a release decision or
a claim of human product acceptance.

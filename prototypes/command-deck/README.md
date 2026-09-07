# Theoses Command Deck prototype

Throwaway visual prototype only. It uses synthetic data and does not connect to Theoses, Telegram, files, providers, memory, or the VPS. The live field uses Three.js from a pinned CDN import map; the HTML/CSS shell remains intentionally disposable.

Run from the repository root:

```bash
python3 -m http.server 8790 -d prototypes/command-deck
```

Open http://127.0.0.1:8790/

Single layout: a full-bleed galaxy field behind chat (left), file workbench (center), and filesystem (right). Each of those three panels has a minimize toggle in its header that folds it to a vertical rail, letting the other two claim the freed width. Runtime settings open from the top rail as a modal.

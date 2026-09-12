Voice model files (`*.onnx` + `*.onnx.json`) go here.

They are downloaded automatically by `npm run setup:piper` (default: `zh_CN-huayan-medium`,
a Traditional/Simplified-compatible Mandarin voice) and are git-ignored because they're
large binary files.

To add more voices, download any voice's `.onnx` and `.onnx.json` pair from
https://huggingface.co/rhasspy/piper-voices and place both files in this folder.
The server auto-detects every `.onnx`/`.onnx.json` pair here and lists them in the
voice picker.

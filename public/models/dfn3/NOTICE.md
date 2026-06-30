# DeepFilterNet 3 — Bundled Assets

Howl ships the DFN3 WASM binary and ONNX model archive so the browser can run
noise suppression without fetching from a third-party CDN at runtime.

## Files

- `v2/pkg/df_bg.wasm` — WebAssembly module (~9.6 MB)
- `v2/models/DeepFilterNet3_onnx.tar.gz` — bundled ONNX model (~7.9 MB)

The `v2/` subdirectory structure is required by the
[`deepfilternet3-noise-filter`](https://www.npmjs.com/package/deepfilternet3-noise-filter)
package (version ≥ 1.2.0), which appends `v2/` to the configured CDN base URL.

## Upstream Sources

- WASM + model: [mezonai/mezon-noise-suppression](https://github.com/mezonai/mezon-noise-suppression) (Apache-2.0 OR MIT)
- Model archive: [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet), `models/DeepFilterNet3_onnx.tar.gz` (Apache-2.0 OR MIT)

## License

See `LICENSE-MIT` and `LICENSE-APACHE` in this directory. Licensed under
either at the user's option, matching the upstream DeepFilterNet project.

## Reference

Schröter, H., Rosenkranz, T., Escalante-B., A.N., & Maier, A. (2022).
*DeepFilterNet: A Low Complexity Speech Enhancement Framework for Full-Band
Audio based on Deep Filtering.* ICASSP 2022.
[arXiv:2110.05588](https://arxiv.org/abs/2110.05588)

# Changelog

## 0.5.0 - 2026-10-13

### Added

- Hardware decode falls back to software decode for the video formats the GPU cannot decode (e.g. 10 bits H.264, HEVC on older Intel GPUs), instead of failing the job. The first time a format is transcoded, the plugin decodes a few frames on the GPU to check it, without any list of GPUs and formats. The result is logged. Works with the `vaapi` and `nvenc` profiles.

### Changed

- The `nvenc` profile uses the H.264 High profile for VOD too. ffmpeg 7.1, shipped by the official PeerTube image, used Main by default.

## 0.4.1 - 2026-10-12

### Changed

- Releases are published to npm from GitHub Actions, with [provenance](https://docs.npmjs.com/generating-provenance-statements). No functional change.

## 0.4.0 - 2026-10-12

### Changed

- The *Quality* setting offers *Quality*, *Balanced* (default), *Speed* and *Driver default* instead of 1 to 7. The plugin translates it to the scale of the GPU: the old value was passed as is to the driver, but Intel and AMD read it differently, and *Automatic* used the fastest preset on AMD. See [Quality setting](README.md#quality-setting).
- Existing values are converted: 1-2 to *Quality*, 6-7 to *Speed*, others (including *Automatic*) to *Balanced*. Nothing changes on Intel and NVIDIA GPUs, AMD GPUs use the balanced preset instead of the speed one.

## 0.3.0 - 2026-10-12

### Added

- `nvenc` transcoding profile for NVIDIA GPUs, select it instead of `vaapi` in the PeerTube transcoding configuration.
- *VAAPI device* and *CUDA device* settings, the VAAPI device was hardcoded to `/dev/dri/renderD128`.
- 240p base bitrate setting.
- Docker documentation for the official PeerTube image: `docker/vaapi-entrypoint.sh` to give the `peertube` user access to the GPU, `docker/Dockerfile` with the non-free Intel driver, NVIDIA setup.

### Fixed

- The *Hardware decode* setting was never enabled.
- 10 bits videos (e.g. iPhone HEVC) failed with hardware decode enabled ([#9](https://github.com/TheoLeCalvar/peertube-plugin-hardware-transcode-vaapi/issues/9)).
- 240p renditions were encoded with a 0 target bitrate.

## Older versions

See the [git history](https://github.com/TheoLeCalvar/peertube-plugin-hardware-transcode-vaapi/commits/main).

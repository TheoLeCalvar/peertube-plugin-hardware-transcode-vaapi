# Hardware h264 encoding using vaapi

This plugin tries to enable hardware accelerated transcoding profiles using vaapi on linux. It should be considered experimental and tinkering will certainly be necessary to make this plugin work on your hardware.


For more information on vaapi and hardware acceleration:

- https://jellyfin.org/docs/general/administration/hardware-acceleration.html#enabling-hardware-acceleration
- https://wiki.archlinux.org/index.php/Hardware_video_acceleration#Comparison_tables


# Docker

The official `chocobozzz/peertube:production` image already ships ffmpeg with VAAPI support and the free VAAPI drivers (`va-driver-all`).
Two extra steps are usually needed: give the PeerTube process access to the GPU, and, for some Intel GPUs, install the non-free Intel driver.
The files mentioned below are in the [`docker/`](docker/) directory of this repository.

## Giving PeerTube access to the GPU

Mounting `/dev/dri` and adding the `render` group with `group_add` is **not enough** with the official image.
Its entrypoint switches to the `peertube` user with `gosu`, which only keeps the groups `peertube` is a named member of in the container's `/etc/group`.
The GID added by `group_add` is dropped, so ffmpeg cannot open the device and every transcode fails with:

```
No VA display found for device /dev/dri/renderD128.
Device creation failed: -22.
```

[`docker/vaapi-entrypoint.sh`](docker/vaapi-entrypoint.sh) fixes this: at startup it adds `peertube` to the group owning `/dev/dri/renderD*` (the GID is read from the device, nothing to configure), then runs the official entrypoint.
Put it next to your `docker-compose.yml`, make it executable (`chmod +x vaapi-entrypoint.sh`) and adapt the `peertube` service:

```yaml
services:
  peertube:
    image: chocobozzz/peertube:production
    # usual peertube configuration
    # ...

    # add these keys
    devices:
      - /dev/dri:/dev/dri
    volumes:
      # keep your existing volumes
      - ./vaapi-entrypoint.sh:/usr/local/bin/vaapi-entrypoint.sh:ro
    entrypoint: ["/usr/local/bin/vaapi-entrypoint.sh"]
    # required, overriding the entrypoint resets the image command
    command: ["node", "dist/server"]
```

`group_add` is not needed.

## Intel GPUs (Gen 8 to Gen 11)

On older Intel GPUs (Broadwell to Ice Lake, e.g. Skylake), the free Intel driver lacks the shader kernels used for scaling and encoding, and transcoding fails with:

```
Failed to create processing pipeline config: 12 (the requested VAProfile is not supported).
```

Build an image with the non-free driver using [`docker/Dockerfile`](docker/Dockerfile), placed next to your `docker-compose.yml`, and force the `iHD` driver:

```yaml
services:
  peertube:
    # replace the image key with
    build:
      context: .
      pull: true # rebuild on top of the latest production image
    environment:
      - LIBVA_DRIVER_NAME=iHD
    # ...
```

Then build and start it with `docker compose build peertube && docker compose up -d --force-recreate peertube`.
To upgrade PeerTube, run `docker compose build --pull peertube` instead of `docker compose pull`.

## Checking the setup

Check that the `peertube` user can scale and encode with VAAPI:

```bash
docker compose exec -u peertube peertube ffmpeg -hide_banner -vaapi_device /dev/dri/renderD128 -f lavfi -i testsrc2=s=1920x1080:d=5 -vf format=nv12,hwupload,scale_vaapi=w=1280:h=720 -c:v h264_vaapi -b:v 2800k -f null -
```

| Error | Cause |
|---|---|
| `Device creation failed: -22` | Permission issue, check that `vaapi-entrypoint.sh` is used (`grep Groups /proc/1/status` inside the container must list the render GID) |
| `Device creation failed: -5` | No working VAAPI driver for this GPU |
| `the requested VAProfile is not supported` | Missing non-free driver, see [Intel GPUs](#intel-gpus-gen-8-to-gen-11) |
| `No usable encoding profile found` | The driver cannot encode H.264 on this GPU |

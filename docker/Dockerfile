FROM chocobozzz/peertube:production

# Full Intel media driver (iHD) with the non-free shader kernels needed on
# older generations (e.g. Skylake) for video processing and encoding.
RUN . /etc/os-release \
 && echo "deb http://deb.debian.org/debian ${VERSION_CODENAME} non-free" > /etc/apt/sources.list.d/non-free.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends intel-media-va-driver-non-free \
 && rm -rf /var/lib/apt/lists/*

#!/bin/sh
set -e

# gosu (used by the official entrypoint) only keeps supplementary groups the
# user is a named member of in /etc/group, so docker's group_add is dropped.
# Add the peertube user to the group owning the render node(s).
for dev in /dev/dri/renderD*; do
    [ -e "$dev" ] || continue
    gid=$(stat -c '%g' "$dev")
    group=$(getent group "$gid" | cut -d: -f1)
    if [ -z "$group" ]; then
        group="render-host"
        groupadd -g "$gid" "$group"
    fi
    usermod -aG "$group" peertube
done

exec /usr/local/bin/entrypoint.sh "$@"

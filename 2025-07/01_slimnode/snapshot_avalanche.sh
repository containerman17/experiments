#!/bin/bash
set -e

LIVE_PATH="/avadata/live"
NODES_PATH="/avadata/nodes"
MAX_SNAPSHOTS=5

if [ "$1" = "create" ]; then
    if [ -z "$2" ]; then
        echo "Usage: $0 create <slot_name>"
        exit 1
    fi
    
    SLOT_NAME="$2"
    SNAPSHOT_PATH="$NODES_PATH/$SLOT_NAME"
    
    echo "Creating snapshot of $LIVE_PATH to $SNAPSHOT_PATH..."
    
    # Remove existing snapshot if it exists
    if [ -d "$SNAPSHOT_PATH" ]; then
        sudo btrfs subvolume delete "$SNAPSHOT_PATH"
    fi
    
    # Create new snapshot
    sudo btrfs subvolume snapshot "$LIVE_PATH" "$SNAPSHOT_PATH"
    sudo chown -R $USER:$USER "$SNAPSHOT_PATH"
    
    echo "Snapshot created: $SNAPSHOT_PATH"

elif [ "$1" = "cleanup" ]; then
    echo "Cleaning up old snapshots, keeping $MAX_SNAPSHOTS most recent..."
    
    cd "$NODES_PATH"
    # List snapshots by modification time, keep newest MAX_SNAPSHOTS
    ls -t | tail -n +$((MAX_SNAPSHOTS + 1)) | while read old_snapshot; do
        echo "Removing old snapshot: $old_snapshot"
        sudo btrfs subvolume delete "$old_snapshot"
    done
    
    echo "Cleanup complete"

elif [ "$1" = "list" ]; then
    echo "Available snapshots:"
    ls -la "$NODES_PATH"

else
    echo "Usage: $0 {create <slot_name>|cleanup|list}"
    echo ""
    echo "Examples:"
    echo "  $0 create slot1           # Create snapshot in slot1"
    echo "  $0 cleanup               # Remove old snapshots"
    echo "  $0 list                  # List all snapshots"
fi 

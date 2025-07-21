#!/bin/bash
set -e

echo "Setting up Avalanche node storage on /dev/nvme1n1..."

# Install btrfs-progs first
sudo apt update
sudo apt install -y btrfs-progs ca-certificates curl

# Install Docker from official repository (idempotent)
echo "Installing Docker from official repository..."

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
    sudo chmod a+r /etc/apt/keyrings/docker.asc
fi

# Add the repository to Apt sources
if [ ! -f /etc/apt/sources.list.d/docker.list ]; then
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
fi

# Update apt and install Docker packages
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add current user to docker group (idempotent)
if ! groups $USER | grep -q '\bdocker\b'; then
    echo "Adding $USER to docker group..."
    sudo usermod -aG docker $USER
    echo "You'll need to log out and back in for Docker group membership to take effect."
else
    echo "User $USER already in docker group."
fi

# Start and enable Docker service
sudo systemctl enable docker
sudo systemctl start docker

# Check if filesystem already exists and is labeled correctly
EXISTING_LABEL=$(sudo blkid -s LABEL -o value /dev/nvme1n1 2>/dev/null || echo "")
if [ "$EXISTING_LABEL" = "avadata" ]; then
    echo "Btrfs filesystem with label 'avadata' already exists on /dev/nvme1n1"
else
    echo "Creating Btrfs filesystem on /dev/nvme1n1..."
    sudo mkfs.btrfs -f -L avadata /dev/nvme1n1
fi

# Create mount point
sudo mkdir -p /avadata

# Check if already mounted
if ! mountpoint -q /avadata; then
    echo "Mounting /dev/nvme1n1 to /avadata..."
    sudo mount -o compress=zstd /dev/nvme1n1 /avadata
else
    echo "/avadata already mounted"
fi

# Add to fstab if not already present
if ! grep -q "LABEL=avadata /avadata" /etc/fstab; then
    echo "Adding to /etc/fstab..."
    echo "LABEL=avadata /avadata btrfs defaults,compress=zstd 0 0" | sudo tee -a /etc/fstab
else
    echo "Entry already exists in /etc/fstab"
fi

# Create Btrfs subvolumes (idempotent)
if [ ! -d /avadata/live ] || ! sudo btrfs subvolume show /avadata/live >/dev/null 2>&1; then
    echo "Creating subvolume /avadata/live..."
    sudo btrfs subvolume create /avadata/live
else
    echo "Subvolume /avadata/live already exists"
fi

# Create nodes directory
sudo mkdir -p /avadata/nodes

# Change ownership to current user
sudo chown -R $USER:$USER /avadata

echo "Storage setup complete!"
echo "Live data will be stored in: /avadata/live"
echo "Snapshots will be stored in: /avadata/nodes"

# Verify setup
df -h /avadata
sudo btrfs filesystem show /avadata 2>/dev/null || echo "Btrfs filesystem info requires elevated permissions"

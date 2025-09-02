#!/bin/bash

# Deploy to Asia
fly deploy --app validator-discovery-asia --primary-region nrt
fly scale count 1 --app validator-discovery-asia 

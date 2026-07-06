# Runner setup guide

This guide walks through installing and registering a self-hosted runner, from download to the first green build. Each step is safe to re-run if something goes wrong halfway.

## Step 1 # download the agent

Grab the latest release tarball for your platform and unpack it into an empty directory owned by the service user. Keep the directory outside the repository checkout.

## Step 2 # register with the server

Run the config script with the registration token from the project settings page. The token is single-use and expires after one hour, so generate it right before registering.
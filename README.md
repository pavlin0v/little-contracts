# GPU Rental Marketplace

This repository contains smart contracts for renting GPUs paid in GPURENT tokens with escrow and provider reputation staking.

Quick start:

1. Install dependencies:

```bash
npm install
```

2. Run tests:

```bash
npx hardhat test
```

3. Deploy (example to polygonAmoy):

```bash
npx hardhat run scripts/deploy.js --network polygonAmoy
```

Environment variables: copy `.env.example` to `.env` and set keys.

## Local API integration

Run a local chain and export contract metadata for `little-blockchain-api`:

```bash
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost
```

The deploy writes `local-chain/deployed-addresses.json` and ABI files under `local-chain/abi/`. It also grants `PROVIDER_ROLE` to the second Hardhat account and transfers GPURENT to the provider and client accounts.

// Hand-pruned ABIs for every contract Kiln touches, in viem's
// human-readable form. Signatures verified against the mainnet-verified
// sources (NetworkedArtFactory 0x0c27…53B2 and THE_VESSEL 0xECb9…1463).

import { parseAbi } from 'viem'

const MINT_PARAMS =
  'struct MintParams { uint256 tokenId; bytes[] artifact; string name; string description; uint32 rendererIndex; uint128 rendererData; }'

export const factoryAbi = parseAbi([
  MINT_PARAMS,
  'function auctions() view returns (address)',
  'function defaultRenderer() view returns (address)',
  'function animationRenderer() view returns (address)',
  'function collectionCount(address artist) view returns (uint256)',
  'function collectionsOf(address artist, uint256 index) view returns (address)',
  'function cloneCollection(string name, string symbol, address expectedAuctions) returns (address art, address edition)',
  'function cloneCollectionAndMint(string name, string symbol, address expectedAuctions, MintParams params, uint96 reserveUsd, uint40 expiresAt) payable returns (address art, address edition, uint256 lotId)',
])

export const collectionAbi = parseAbi([
  MINT_PARAMS,
  'struct TokenData { string name; string description; address[] artifact; uint256 lotId; uint32 renderer; uint128 data; }',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function latestTokenId() view returns (uint256)',
  'function rendererCount() view returns (uint256)',
  'function rendererAt(uint32 index) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function tokenData(uint256 tokenId) view returns (TokenData)',
  'function tokenArtifact(uint256 tokenId) view returns (bytes)',
  'function mint(MintParams params)',
  'function mintToLot(MintParams params, uint96 reserveUsd, uint40 expiresAt) payable returns (uint256 lotId)',
  'function prepareArtifact(uint256 tokenId, bytes[] chunks, bool clear)',
  'function registerRenderer(address renderer) returns (uint256 index)',
])

export const auctionsAbi = parseAbi([
  'function ETH_USD() view returns (address)',
])

export const chainlinkAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])

export const vesselAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function craftToType(uint256 tokenId) view returns (string)',
  'function craftToVaultStatus(uint256 tokenId) view returns (bool)',
  'function craftToLocked(uint256 tokenId) view returns (bool)',
  'function craftToEntry(uint256 tokenId) view returns (uint256)',
  'function craftToChosenEntry(uint256 tokenId) view returns (uint256)',
  'function vaultToEntry(uint256 tokenId, uint256 entry) view returns (bytes)',
  'function craftToPayload(uint256 tokenId) view returns (bytes)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])

export const relicsAbi = parseAbi([
  'function isRelic(uint256 tokenId) view returns (bool)',
  'function relicToPayload(uint256 tokenId) view returns (bytes)',
  'function vaultRelicToEntry(uint256 tokenId, uint256 entry) view returns (bytes)',
  'function getTokenEntries(uint256 tokenId) view returns (uint256)',
  'function getTokenKind(uint256 tokenId) view returns (string)',
])

export const vesselPortalAbi = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (uint256)',
  'function vessel() view returns (address)',
  'function resolve(string mime, uint256 vesselTokenId, uint256[] entries, uint8 source) view returns (bytes content, string animation)',
  'function resolveArtifact(bytes artifact) view returns (bytes content, string animation)',
  'function previewURI(bytes artifact) view returns (string metadata, uint256 gasUsed)',
  'function selfTest(uint256 vesselTokenId) view returns (bool)',
  'function MAX_CONTENT_BYTES() view returns (uint256)',
  'function MAX_ENTRIES() view returns (uint256)',
])

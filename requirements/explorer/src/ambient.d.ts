/**
 * Ambient shims for optional deps of the electrobun package that we don't use
 * directly (three.js / Babylon are imported by electrobun/bun's API surface).
 */
declare module "three";
declare module "@babylonjs/core";

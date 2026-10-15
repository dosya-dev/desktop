// Ambient declarations for Vite virtual modules. This file must stay free of
// imports: with one, `declare module` becomes an augmentation of an existing
// module rather than the declaration of a new one.

// Built by scripts/acknowledgements-plugin.ts from package.json at build time.
declare module "virtual:acknowledgements" {
  const list: { name: string; version: string; license: string; text: string | null }[];
  export default list;
}

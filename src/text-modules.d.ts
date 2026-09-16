// wrangler bundles these as strings (see [[rules]] in wrangler.toml).
declare module "*.eta" {
  const src: string;
  export default src;
}
declare module "*.css" {
  const src: string;
  export default src;
}

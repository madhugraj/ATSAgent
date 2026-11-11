/**
 * Server-side stub for the browser-only 3D stack (three, three-spritetext,
 * react-force-graph-3d). Those packages read `window.THREE` while they are being
 * evaluated, so when the server bundler pulled them in, every server-rendered
 * page crashed with "window is not defined".
 *
 * The 3D view is only ever rendered in the browser (lazy import in
 * src/routes/brain.tsx), so the server can safely resolve these packages to this
 * inert module — nothing here is ever called during server rendering.
 */
const inert: unknown = new Proxy(function noop() {} as unknown as object, {
  get: () => inert,
  apply: () => inert,
  construct: () => ({}) as object,
});

export default inert as never;
// Named imports of three's add-ons (src/components/OrgOntology3D.tsx): the
// production server build fails on a missing export otherwise.
export const OrbitControls = inert as never;
export const CSS2DObject = inert as never;
export const CSS2DRenderer = inert as never;
export const __browser3dStub = true;

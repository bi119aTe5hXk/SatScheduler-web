declare module 'encom-globe' {
  const Globe: new (width: number, height: number, options: Record<string, unknown>) => any
  export default Globe
}

declare module 'encom-globe/build/encom-globe.js?raw' {
  const source: string
  export default source
}

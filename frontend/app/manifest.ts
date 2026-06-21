import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Megumi Reader',
    short_name: 'Megumi',
    description: 'Static reader for Megumi manifests',
    start_url: '/',
    display: 'standalone',
    background_color: '#111316',
    theme_color: '#111316',
    icons: [
      {
        src: '/web-app-manifest-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/web-app-manifest-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}

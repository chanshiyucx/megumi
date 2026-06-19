import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import '@/styles/index.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const viewport: Viewport = {
  themeColor: '#111316',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
}

export const metadata: Metadata = {
  title: 'Megumi Reader',
  description: 'Static reader for Megumi manifests',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}

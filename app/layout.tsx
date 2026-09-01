import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
  title: 'OI Lens — Six-Month Calibrated Options Levels',
  description: 'Instrument-specific support and resistance from live options OI and six months of walk-forward historical validation.',
  openGraph: {
    title: 'OI Lens — Six-Month Calibrated Options Levels',
    description: 'Instrument-specific support and resistance from options positioning.',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'OI Lens market structure dashboard' }],
  },
  twitter: { card: 'summary_large_image', images: ['/og.png'] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

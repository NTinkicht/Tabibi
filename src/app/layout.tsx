import type { Metadata } from 'next';
import './styles.css';
import './wu85-accessibility.css';

export const metadata: Metadata = {
  title: 'Tabibi',
  description: 'Algeria-first clinic queue management',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

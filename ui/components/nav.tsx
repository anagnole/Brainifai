'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const navItems = [
  {
    href: '/',
    label: 'Dashboard',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="7" height="7" x="3" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="14" rx="1" />
        <rect width="7" height="7" x="3" y="14" rx="1" />
      </svg>
    ),
  },
  {
    href: '/sources',
    label: 'Sources',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22v-5" />
        <path d="M9 8V2" />
        <path d="M15 8V2" />
        <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
      </svg>
    ),
  },
  {
    href: '/ingest',
    label: 'Ingest',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="6 3 20 12 6 21 6 3" />
      </svg>
    ),
  },
  {
    href: '/explore',
    label: 'Explore',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    ),
  },
]

export default function Nav() {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col w-16 md:w-56 h-screen bg-zinc-900 border-r border-zinc-800 flex-shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-zinc-800">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M3 12h3m12 0h3M12 3v3m0 12v3" />
            <path d="m5.6 5.6 2.1 2.1m8.5 8.5 2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
          </svg>
        </div>
        <span className="hidden md:block font-semibold text-zinc-100 text-sm tracking-wide">
          Brainifai
        </span>
      </div>

      {/* Nav links */}
      <ul className="flex flex-col gap-1 p-2 mt-2">
        {navItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium ${
                  isActive
                    ? 'bg-indigo-500/20 text-indigo-400'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
                }`}
              >
                <span className="flex-shrink-0">{item.icon}</span>
                <span className="hidden md:block">{item.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

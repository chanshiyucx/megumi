import { Moon, RefreshCw, Sun, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/style'
import { useUIStore, type ThemeMode } from '@/store/ui'

interface Theme {
  mode: ThemeMode
  icon: LucideIcon
  label: string
}

const themes: Theme[] = [
  { mode: 'light', icon: Sun, label: '浅色' },
  { mode: 'dark', icon: Moon, label: '深色' },
]

interface ThemeSwitcherProps {
  onRefresh: () => void
}

export function ThemeSwitcher({ onRefresh }: ThemeSwitcherProps) {
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)

  return (
    <div className="bg-overlay flex h-8 min-w-0 flex-1 items-center justify-evenly gap-1 rounded-full">
      {themes.map(({ mode, icon: Icon, label }) => {
        const isActive = theme === mode
        return (
          <Button
            key={mode}
            onClick={() => {
              setTheme(mode)
            }}
            className={cn(
              'hover:text-love h-6 w-6 bg-transparent p-0 transition-colors',
              isActive ? 'text-love' : 'text-text',
            )}
            title={label}
            aria-label={label}
          >
            <Icon className="h-4 w-4" />
          </Button>
        )
      })}
      <Button
        onClick={onRefresh}
        className="hover:text-love text-text h-6 w-6 bg-transparent p-0 transition-colors"
        title="刷新"
        aria-label="刷新"
      >
        <RefreshCw className="h-4 w-4" />
      </Button>
    </div>
  )
}

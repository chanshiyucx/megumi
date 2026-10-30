import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface RemoteProgressPromptProps {
  // Where the other device is, e.g. "第十二章 · 35%".
  label: string
  onJump: () => void
  onDismiss: () => void
}

// Floats at the bottom of a reader when another device has read this comic /
// book further; jumping is the reader's choice, never automatic.
export function RemoteProgressPrompt({
  label,
  onJump,
  onDismiss,
}: RemoteProgressPromptProps) {
  return (
    <div
      role="status"
      className="bg-base text-text absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1 rounded-sm border py-1 pr-1 pl-3 text-xs shadow-md"
    >
      <span className="min-w-0 truncate" title={label}>
        其他设备读到 {label}
      </span>
      <Button className="text-love h-6 px-2 text-xs" onClick={onJump}>
        跳转
      </Button>
      <Button
        className="h-6 w-6"
        onClick={onDismiss}
        title="留在当前位置"
        aria-label="留在当前位置"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

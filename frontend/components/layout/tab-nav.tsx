import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable'
import {
  Columns2,
  InspectionPanel,
  PanelLeft,
  PanelLeftDashed,
  X,
} from 'lucide-react'
import { useEffect, useEffectEvent } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SHORTCUTS } from '@/lib/shortcuts'
import { cn } from '@/lib/style'
import { useTabsStore, type Tab } from '@/store/tabs'
import { useUIStore } from '@/store/ui'

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 8 } }

interface TabItemProps {
  tab: Tab
  isActive: boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}

function TabItem({ tab, isActive, onSelect, onRemove }: TabItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id })

  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'bg-surface hover:bg-overlay group flex max-w-50 min-w-37.5 cursor-grab items-center gap-2 rounded-sm px-3 py-1 text-sm',
        isActive && 'bg-overlay text-love',
        isDragging && 'z-10 cursor-grabbing opacity-80',
      )}
      onClick={() => {
        onSelect(tab.id)
      }}
    >
      <span className="flex-1 truncate">{tab.title}</span>
      <Button
        className="h-4 w-4 bg-transparent opacity-0 group-hover:opacity-100"
        onPointerDown={(e) => {
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.stopPropagation()
          onRemove(tab.id)
        }}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
}

export function TabNav() {
  const isSidebarCollapsed = useUIStore((s) => s.isSidebarCollapsed)
  const isMiddleCollapsed = useUIStore((s) => s.isMiddleCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const toggleMiddle = useUIStore((s) => s.toggleMiddle)
  const toggleImmersive = useUIStore((s) => s.toggleImmersive)
  const tabs = useTabsStore((s) => s.tabs)
  const activeTab = useTabsStore((s) => s.activeTab)
  const removeTab = useTabsStore((s) => s.removeTab)
  const reorderTab = useTabsStore((s) => s.reorderTab)
  const setActiveTab = useTabsStore((s) => s.setActiveTab)
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS))

  const handleSidebar = () => {
    if (activeTab) setActiveTab('')
    else toggleSidebar()
  }
  const handleMiddle = () => {
    if (activeTab) setActiveTab('')
    else toggleMiddle()
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    reorderTab(active.id as string, over.id as string)
  }

  const navigateTab = (direction: 1 | -1) => {
    if (!tabs.length) return

    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab)

    if (direction === -1) {
      if (currentIndex > 0) {
        setActiveTab(tabs[currentIndex - 1].id)
      } else if (currentIndex === -1) {
        setActiveTab(tabs[tabs.length - 1].id)
      } else if (currentIndex === 0) {
        setActiveTab('')
      }
    } else if (direction === 1) {
      if (currentIndex < tabs.length - 1 && currentIndex !== -1) {
        setActiveTab(tabs[currentIndex + 1].id)
      } else if (currentIndex === -1) {
        setActiveTab(tabs[0].id)
      } else if (currentIndex === tabs.length - 1) {
        setActiveTab('')
      }
    }
  }

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return

    switch (e.code) {
      case SHORTCUTS.toggleImmersive:
        e.preventDefault() // Prevent page scrolling
        toggleImmersive()
        break
      case SHORTCUTS.closeTab:
        removeTab(activeTab)
        break
      case SHORTCUTS.toggleSidebar:
        toggleSidebar()
        break
      case SHORTCUTS.toggleMiddlePanel:
        toggleMiddle()
        break
      case SHORTCUTS.prevTab:
      case SHORTCUTS.nextTab:
        navigateTab(e.code === SHORTCUTS.prevTab ? -1 : 1)
        break
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <div className="bg-base flex h-8 shrink-0 items-center gap-2 border-b px-3">
      <Button
        className="h-6 w-6"
        onClick={handleSidebar}
        title={activeTab ? '返回主页' : '折叠/展开左边栏'}
      >
        {isSidebarCollapsed ? (
          <PanelLeftDashed className="h-4 w-4" />
        ) : (
          <PanelLeft className="h-4 w-4" />
        )}
      </Button>

      <Button
        className="h-6 w-6"
        onClick={handleMiddle}
        title={activeTab ? '返回主页' : '折叠/展开中间栏'}
      >
        {isMiddleCollapsed ? (
          <InspectionPanel className="h-4 w-4" />
        ) : (
          <Columns2 className="h-4 w-4" />
        )}
      </Button>

      <ScrollArea
        orientation="horizontal"
        viewportClassName="flex-1"
        className="flex items-center gap-1"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                isActive={activeTab === tab.id}
                onSelect={setActiveTab}
                onRemove={removeTab}
              />
            ))}
          </SortableContext>
        </DndContext>
      </ScrollArea>
    </div>
  )
}

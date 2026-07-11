import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { BookImage, Clapperboard, LibraryBig } from "lucide-react";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePanelNav } from "@/hooks/use-panel-nav";
import { cn } from "@/lib/style";
import { useLibraryStore } from "@/store/library";
import { useUIStore } from "@/store/ui";
import { LibraryType, type Library } from "@/types/library";

const LibraryIcon = {
  [LibraryType.book]: LibraryBig,
  [LibraryType.comic]: BookImage,
  [LibraryType.video]: Clapperboard,
};

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 8 } };

function reorderLibraryIdsAfterDrag(
  libraryIds: string[],
  activeId: string,
  overId: string | null | undefined,
) {
  if (!overId || activeId === overId) return null;

  const oldIndex = libraryIds.indexOf(activeId);
  const newIndex = libraryIds.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1) return null;

  const newOrder = [...libraryIds];
  newOrder.splice(oldIndex, 1);
  newOrder.splice(newIndex, 0, activeId);
  return newOrder;
}

interface SortableLibraryItemProps {
  library: Library;
  isSelected: boolean;
  onSelect: (library: Library) => void;
}

function SortableLibraryItem({
  library,
  isSelected,
  onSelect,
}: SortableLibraryItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: library.id });

  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  const Icon = LibraryIcon[library.type];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("group relative", isDragging && "z-10 opacity-80")}
    >
      <Button
        className={cn(
          "h-8 w-full justify-start gap-2 rounded-none px-4 transition-all duration-300",
          isSelected && "bg-overlay text-love",
        )}
        onClick={() => {
          onSelect(library);
        }}
      >
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span>{library.name}</span>
      </Button>
    </div>
  );
}

export function Sidebar() {
  const isSidebarCollapsed = useUIStore((s) => s.isSidebarCollapsed);
  const selectedLibraryId = useUIStore((s) => s.selectedLibraryId);
  const setSelectedLibraryId = useUIStore((s) => s.setSelectedLibraryId);
  const { openMiddle } = usePanelNav();

  const libraries = useLibraryStore((s) => s.libraries);
  const refreshCurrentResource = useLibraryStore((s) => s.refreshCurrentResource);
  const reorderLibrary = useLibraryStore((s) => s.reorderLibrary);

  const librariesList = Object.values(libraries).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const libraryIds = librariesList.map((lib) => lib.id);

  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const newOrder = reorderLibraryIdsAfterDrag(
      libraryIds,
      active.id as string,
      over?.id as string | null | undefined,
    );
    if (newOrder) reorderLibrary(newOrder);
  };

  const handleSelect = (library: Library) => {
    setSelectedLibraryId(library.id);
    openMiddle();
  };

  return (
    <aside
      aria-label="库侧边栏"
      className={cn(
        "bg-base h-full min-h-0 w-full flex-col border-r md:w-56",
        isSidebarCollapsed ? "hidden" : "flex",
      )}
    >
      <ScrollArea aria-label="库列表" viewportClassName="min-h-0 flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={libraryIds}
            strategy={verticalListSortingStrategy}
          >
            {librariesList.map((lib) => (
              <SortableLibraryItem
                key={lib.id}
                library={lib}
                isSelected={selectedLibraryId === lib.id}
                onSelect={handleSelect}
              />
            ))}
          </SortableContext>
        </DndContext>
      </ScrollArea>

      <div className="flex w-full shrink-0 items-center gap-2 p-4">
        <ThemeSwitcher onRefresh={() => void refreshCurrentResource()} />
      </div>
    </aside>
  );
}

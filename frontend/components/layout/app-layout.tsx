import { LibraryArea } from './library-area'
import { Sidebar } from './sidebar'
import { TabArea } from './tab-area'
import { TabNav } from './tab-nav'

export function AppLayout() {
  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden">
      <TabNav />

      <TabArea />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <LibraryArea />
      </div>
    </div>
  )
}

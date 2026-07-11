# Megumi

Megumi builds static reader assets from a local media library. This glossary names the content boundaries used when reasoning about build speed, checkpointing, and generated outputs.

## Language

**Content Unit**:
A resumable build boundary. A single comic is one content unit; a book author directory is one content unit; a video file is one content unit.
_Avoid_: Batch, job, folder

**Comic**:
A single manga represented by one content directory containing image pages.
_Avoid_: Comic directory, manga folder, image batch

**Book Author**:
A directory that groups text books by author and is built as one content unit.
_Avoid_: Book batch, author folder

**Video**:
A single MP4 file stored directly inside a video library. Video libraries do not contain nested content directories.
_Avoid_: Video folder, episode directory

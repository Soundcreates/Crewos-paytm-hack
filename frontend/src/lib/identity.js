export function emblemIndex(identity = '') {
  return Array.from(String(identity)).reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) >>> 0, 0) % 6;
}
// The same paths are rendered by SVG in the interface and Konva on the office map.
export const emblemPaths = [
  'M10 10h8v28h-8zM22 10h8v28h-8zM34 10h5v28h-5z',
  'M24 7a17 17 0 1 0 0 34 17 17 0 1 0 0-34zM24 15a9 9 0 1 1 0 18 9 9 0 1 1 0-18zM24 7h17v17h-8v-9h-9z',
  'M9 10h30v8H9zM9 23h22v8H9zM9 36h14v5H9z',
  'M24 5 43 24 24 43 5 24zM24 15 15 24 24 33 33 24z',
  'M9 9h13v13H9zM27 9h13v13H27zM9 27h13v13H9zM33.5 27a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13z',
  'M9 10h8v30H9zM21 10h8v22h-8zM33 10h8v14h-8z',
];

import bg1 from '../../images/download-21.webp';
import bg2 from '../../images/download-22.webp';
import bg3 from '../../images/download-24.webp';
import bg4 from '../../images/download-25.webp';
import bg5 from '../../images/download-26.webp';
import bg6 from '../../images/download-27.webp';
import bg7 from '../../images/download-28.webp';

export const WORKSPACE_BACKGROUNDS = [
  { id: 'green-fields', label: 'Green Fields', src: bg1 },
  { id: 'red-canyon', label: 'Red Canyon', src: bg2 },
  { id: 'palm-beach', label: 'Palm Beach', src: bg3 },
  { id: 'forest-gate', label: 'Forest Gate', src: bg4 },
  { id: 'night-battle', label: 'Night Battle', src: bg5 },
  { id: 'sky-meadow', label: 'Sky Meadow', src: bg6 },
  { id: 'sunset-canyon', label: 'Sunset Canyon', src: bg7 },
];

export const WORKSPACE_BACKGROUND_IMAGES = WORKSPACE_BACKGROUNDS.map(background => background.src);

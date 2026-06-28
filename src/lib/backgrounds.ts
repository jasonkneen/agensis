import bg1 from '../../images/download-21.jpg';
import bg2 from '../../images/download-22.jpg';
import bg3 from '../../images/download-24.jpg';
import bg4 from '../../images/download-25.jpg';
import bg5 from '../../images/download-26.jpg';

export const WORKSPACE_BACKGROUNDS = [
  { id: 'green-fields', label: 'Green Fields', src: bg1 },
  { id: 'red-canyon', label: 'Red Canyon', src: bg2 },
  { id: 'palm-beach', label: 'Palm Beach', src: bg3 },
  { id: 'forest-gate', label: 'Forest Gate', src: bg4 },
  { id: 'night-battle', label: 'Night Battle', src: bg5 },
];

export const WORKSPACE_BACKGROUND_IMAGES = WORKSPACE_BACKGROUNDS.map(background => background.src);

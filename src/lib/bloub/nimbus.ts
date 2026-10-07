/** Character geometry adapted from the owner-provided Nimbus & Friends artwork.
 * Static SVG only; animation and expressions remain owned by BotEngine. */
export const NIMBUS_CHARACTERS = [
  {
    "id": "nimbus",
    "name": "Nimbus",
    "face": {
      "x": 104,
      "y": 138,
      "sp": 20
    },
    "feet": [
      78,
      126
    ],
    "footY": 188,
    "highlight": [
      90,
      80,
      24,
      13,
      -25
    ],
    "body": "<rect x=\"36\" y=\"122\" width=\"132\" height=\"66\" rx=\"33\" fill=\"var(--nimbus-fill)\"/><circle cx=\"72\" cy=\"118\" r=\"34\" fill=\"var(--nimbus-fill)\"/><circle cx=\"112\" cy=\"92\" r=\"44\" fill=\"var(--nimbus-fill)\"/><circle cx=\"150\" cy=\"122\" r=\"30\" fill=\"var(--nimbus-fill)\"/>",
    "back": "",
    "front": ""
  },
  {
    "id": "pip",
    "name": "Pip",
    "face": {
      "x": 100,
      "y": 112,
      "sp": 21
    },
    "feet": [
      80,
      120
    ],
    "footY": 184,
    "highlight": [
      76,
      72,
      22,
      10,
      -20
    ],
    "body": "<polygon points=\"42,112 72,56 128,56 158,112 128,168 72,168\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-fill)\" stroke-width=\"24\" stroke-linejoin=\"round\"/>",
    "back": "",
    "front": ""
  },
  {
    "id": "sprout",
    "name": "Sprout",
    "face": {
      "x": 100,
      "y": 136,
      "sp": 19
    },
    "feet": [
      82,
      118
    ],
    "footY": 190,
    "highlight": [
      74,
      128,
      10,
      22,
      15
    ],
    "body": "<path d=\"M100 52C128 52 136 92 156 122C180 156 168 194 100 194C32 194 20 156 44 122C64 92 72 52 100 52Z\" fill=\"var(--nimbus-fill)\"/>",
    "back": "",
    "front": "<g class=\"part\" style=\"--ox:100px;--oy:56px;--s:1\"><path d=\"M100 58C100 46 99 36 95 27\" fill=\"none\" stroke=\"var(--nimbus-fill)\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M95 30C84 13 62 17 59 32C73 41 89 41 95 30Z\" fill=\"var(--nimbus-fill)\"/><path d=\"M96 30C105 11 130 10 138 25C126 39 107 40 96 30Z\" fill=\"var(--nimbus-fill)\"/></g>"
  },
  {
    "id": "mochi",
    "name": "Mochi",
    "face": {
      "x": 100,
      "y": 122,
      "sp": 20
    },
    "feet": [
      76,
      124
    ],
    "footY": 186,
    "highlight": [
      62,
      88,
      22,
      10,
      -8
    ],
    "body": "<rect x=\"30\" y=\"62\" width=\"140\" height=\"124\" rx=\"42\" fill=\"var(--nimbus-fill)\"/>",
    "back": "<g class=\"part\" style=\"--ox:58px;--oy:72px;--s:-1\"><circle cx=\"56\" cy=\"60\" r=\"17\" fill=\"var(--nimbus-fill)\"/><circle cx=\"56\" cy=\"61\" r=\"8\" fill=\"#d8c3ff\"/></g><g class=\"part\" style=\"--ox:142px;--oy:72px;--s:1\"><circle cx=\"144\" cy=\"60\" r=\"17\" fill=\"var(--nimbus-fill)\"/><circle cx=\"144\" cy=\"61\" r=\"8\" fill=\"#d8c3ff\"/></g>",
    "front": ""
  },
  {
    "id": "pebble",
    "name": "Pebble",
    "face": {
      "x": 100,
      "y": 116,
      "sp": 24
    },
    "feet": [
      80,
      120
    ],
    "footY": 190,
    "highlight": [
      72,
      84,
      24,
      13,
      -35
    ],
    "body": "<circle cx=\"100\" cy=\"124\" r=\"68\" fill=\"var(--nimbus-fill)\"/>",
    "back": "",
    "front": "<g class=\"part\" style=\"--ox:56px;--oy:136px;--s:1\"><ellipse cx=\"46\" cy=\"152\" rx=\"22\" ry=\"15\" transform=\"rotate(-28 46 152)\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-dark)\" stroke-opacity=\".25\" stroke-width=\"2\"/></g><g class=\"part\" style=\"--ox:144px;--oy:136px;--s:-1\"><ellipse cx=\"154\" cy=\"152\" rx=\"22\" ry=\"15\" transform=\"rotate(28 154 152)\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-dark)\" stroke-opacity=\".25\" stroke-width=\"2\"/></g>"
  },
  {
    "id": "dew",
    "name": "Dew",
    "face": {
      "x": 100,
      "y": 142,
      "sp": 19
    },
    "feet": [
      82,
      118
    ],
    "footY": 190,
    "highlight": [
      78,
      104,
      11,
      25,
      25
    ],
    "body": "<path d=\"M100 20C115 56 165 100 165 146C165 180 135 196 100 196C65 196 35 180 35 146C35 100 85 56 100 20Z\" fill=\"var(--nimbus-fill)\"/>",
    "back": "<g class=\"part\" style=\"--ox:46px;--oy:140px;--s:1\"><ellipse cx=\"30\" cy=\"144\" rx=\"13\" ry=\"25\" transform=\"rotate(-38 30 144)\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-dark)\" stroke-opacity=\".25\" stroke-width=\"2\"/></g><g class=\"part\" style=\"--ox:154px;--oy:140px;--s:-1\"><ellipse cx=\"170\" cy=\"144\" rx=\"13\" ry=\"25\" transform=\"rotate(38 170 144)\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-dark)\" stroke-opacity=\".25\" stroke-width=\"2\"/></g>",
    "front": ""
  },
  {
    "id": "twinkle",
    "name": "Twinkle",
    "face": {
      "x": 100,
      "y": 128,
      "sp": 18
    },
    "feet": [
      80,
      120
    ],
    "footY": 184,
    "highlight": [
      80,
      88,
      14,
      8,
      -30
    ],
    "body": "<polygon points=\"100.0,46.0 127.0,78.8 166.6,94.4 143.7,130.2 141.1,172.6 100.0,162.0 58.9,172.6 56.3,130.2 33.4,94.4 73.0,78.8\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-fill)\" stroke-width=\"22\" stroke-linejoin=\"round\"/>",
    "back": "",
    "front": ""
  },
  {
    "id": "miso",
    "name": "Miso",
    "face": {
      "x": 100,
      "y": 115,
      "sp": 20,
      "noBlush": true
    },
    "feet": [
      78,
      122
    ],
    "footY": 188,
    "highlight": [
      64,
      78,
      16,
      8,
      -30
    ],
    "body": "<rect x=\"40\" y=\"62\" width=\"120\" height=\"126\" rx=\"52\" fill=\"var(--nimbus-fill)\"/>",
    "back": "<g class=\"part\" style=\"--ox:100px;--oy:66px;--s:1\"><path d=\"M100 68V36\" stroke=\"var(--nimbus-fill)\" stroke-width=\"5\" stroke-linecap=\"round\"/><circle cx=\"100\" cy=\"27\" r=\"10\" fill=\"var(--nimbus-fill)\"/></g>",
    "front": "<g class=\"part\" style=\"--ox:44px;--oy:120px;--s:1\"><ellipse cx=\"34\" cy=\"140\" rx=\"12\" ry=\"24\" transform=\"rotate(14 34 140)\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-dark)\" stroke-opacity=\".25\" stroke-width=\"2\"/></g><g class=\"part\" style=\"--ox:156px;--oy:120px;--s:-1\"><ellipse cx=\"166\" cy=\"140\" rx=\"12\" ry=\"24\" transform=\"rotate(-14 166 140)\" fill=\"var(--nimbus-fill)\" stroke=\"var(--nimbus-dark)\" stroke-opacity=\".25\" stroke-width=\"2\"/></g><rect x=\"56\" y=\"86\" width=\"88\" height=\"58\" rx=\"29\" fill=\"#151a25\"/><path d=\"M72 94Q100 87 128 94\" fill=\"none\" stroke=\"#fff\" stroke-opacity=\".14\" stroke-width=\"3\" stroke-linecap=\"round\"/>"
  }
] as const;

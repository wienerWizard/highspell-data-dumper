# data dumper plugin for HighSpell©®™
collect skilling data, and export it for analysis

goals:
* generally find out how many items you can expect to receive per hour of skilling with a given loadout
* explain the 'probability' value defined in game code (forestry, fishing, crime)
* define invisible equipment bonuses (hatchets, pickaxes)
* define skill level impact
* find rates for rare items (lucky logs, gems, messages in bottles, fuchsia/cela keys)

measures:
* data about a collected skilling resource (e.g. logs):
   * item type
   * time to collect (milliseconds)
   * IOU state
* your total level for that skill, including potion boosts and invisible equipment boosts
* equipment worn
* skilling target (e.g. ore rock, tree type)

data is grouped by similar attributes, so any changes (levelling up, equipment change, different target) will start a new group

## how to use?
this plugin is not published on the ryelite plugin hub, so you'll need to build ryelite yourself with the compiled plugin.

1. grab ryelite: https://github.com/RyeL1te/RyeliteDesktop

2. grab compiled plugin from this repo: `dist/DataDumper.js`
   sha256: F2DE25C94B2D0A3C6D57C2C536EA5C8535300F9BE545939C282B0FB268CF485D

3. drop the .js file into `RyeLiteDesktop/src/renderer/client/plugins/` and build ryelite

maybe someday it will be on the plugin hub :^)

## build it yourself
see https://github.com/RyeL1te/Example-Plugin for general build instructions

## other stuff
some extra bits in `extra/`:
* `sample-export.json` - a sample of forestry data exported from the plugin
* `analysis.xlsx` - an analysis of the data to try and find probabilities (failed)
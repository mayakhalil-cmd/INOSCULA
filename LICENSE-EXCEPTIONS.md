# License exceptions

Inoscula is free software under the GNU Affero General Public License, version 3 or later (see LICENSE).
This file adds permissions on top of that license, as section 7 of the AGPL allows. They apply to every
version of Inoscula that carries this file.

## What you make with Inoscula is yours

The license covers Inoscula itself: the compiler, the Studio, the bridge, the importers and their source.
It does not cover:

- shaders you write in Inoscula code (`.inoscula` files) and the graphs you build (`.inoscula.json`);
- the files Inoscula writes for you: Blender and Unreal Python scripts, Godot `.tres` and `.gdshader` files,
  Unity HLSL and `.shader` files, RICO and three.js materials, and the node graphs inside them;
- scripts you write for the Studio's scripting panel;
- renders, videos, installations, performances and anything else made with those.

As an additional permission, you may use, change, sell and share all of the above under any license you choose,
including closed ones, even where an export contains code copied from Inoscula (for example the noise
functions every export carries). You do not have to publish your shaders, your exports or your projects.

The noise in those exports is a port of Blender's Cycles noise, which is under the Apache License 2.0
(see NOTICE). Apache-2.0 allows the same use, closed or open; if you hand out an export's code, include the lines
from NOTICE with it.

## What stays open

If you share Inoscula, or a changed copy of it, you share its full source under the AGPL. If you run a changed
copy for other people over a network, for example a hosted Studio, you offer them its source.

## The name

The Inoscula name and logo are not covered by the license. Changed copies should use another name, or say
clearly that they are changed.

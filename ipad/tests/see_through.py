"""Does the Home Screen wallpaper show through the app? (experimental see-through window)

    python3 ipad/tests/see_through.py <home screen.png> <app.png>

Compares the structure of a Home Screen screenshot with one of the app: the
glass tints and dims what is behind it, but the wallpaper's shapes stay, so the
two correlate when the window is see-through and don't when it is opaque.
Reports only; never fails the build.
"""

import sys

import numpy as np
from PIL import Image


def gray(path, size=(96, 128)):
    image = Image.open(path).convert("L").resize(size)
    return np.asarray(image, dtype=float)


home, app = gray(sys.argv[1]), gray(sys.argv[2])
# Leave out the status bar and the toolbar row, which differ anyway.
home, app = home[12:], app[12:]
corr = float(np.nan_to_num(np.corrcoef(home.ravel(), app.ravel())[0, 1]))
print(f"see-through: correlation with the Home Screen = {corr:.2f} "
      f"(home mean {home.mean():.0f}, app mean {app.mean():.0f}, app spread {app.std():.0f})")
print("see-through: " + ("the Home Screen shows through" if corr > 0.45 else "the window looks opaque"))

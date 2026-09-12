"""Compatibility entry point for the transparent pixel-art generator."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
subprocess.run(["node", str(root / "scripts" / "generate-icons.mjs")], cwd=root, check=True)

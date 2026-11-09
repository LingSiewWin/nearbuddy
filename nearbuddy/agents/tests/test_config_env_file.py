"""config.env_file: a git worktree, which has no .env of its own, reads the main checkout's."""

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import env_file  # noqa: E402


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


def test_worktree_falls_back_to_main_checkout_env(tmp_path: Path) -> None:
    main = tmp_path / "main"
    (main / "nearbuddy").mkdir(parents=True)
    _git(main, "init", "-q")
    (main / "nearbuddy" / "keep").write_text("x")
    _git(main, "add", ".")
    _git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    (main / "nearbuddy" / ".env").write_text("K=v\n")
    wt = tmp_path / "wt"
    _git(main, "worktree", "add", "-q", str(wt))

    assert env_file(main / "nearbuddy") == main / "nearbuddy" / ".env"  # own file wins
    assert env_file(wt / "nearbuddy").resolve() == (main / "nearbuddy" / ".env").resolve()


def test_outside_git_keeps_own_path(tmp_path: Path) -> None:
    assert env_file(tmp_path) == tmp_path / ".env"

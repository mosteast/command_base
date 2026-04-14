import os
import sys
import traceback


def _apply_command_base_f2_patch():
    if os.environ.get("COMMAND_BASE_F2_PATCH") != "1":
        return

    try:
        from f2_douyin_patch import apply_patch

        apply_patch()
    except Exception as error:  # pragma: no cover - safety net for real CLI usage
        print(
            f"[command_base] failed to apply f2 Douyin compatibility patch: {error}",
            file=sys.stderr,
        )
        traceback.print_exc()


_apply_command_base_f2_patch()

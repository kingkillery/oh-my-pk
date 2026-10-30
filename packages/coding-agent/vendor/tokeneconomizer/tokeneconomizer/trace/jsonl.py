"""Reading a JSONL log line by line, skipping what does not parse."""
import json


def lines(path):
    """Non-empty, stripped lines of a text file; nothing when it cannot be read."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    yield line
    except OSError:
        return


def records(path):
    """Each line of a JSONL file that parses to a JSON object."""
    for line in lines(path):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev, dict):
            yield ev

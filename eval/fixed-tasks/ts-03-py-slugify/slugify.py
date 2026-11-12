import re
import unicodedata


def slugify(title, max_length=60):
    normalized = unicodedata.normalize("NFKD", title)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    words = re.findall(r"[a-z0-9]+", ascii_only.lower())
    slug = "-".join(words)
    return slug[:max_length].rstrip("-")


def is_slug(text):
    return re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", text) is not None

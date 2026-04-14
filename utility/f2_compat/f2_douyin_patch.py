import json


PATCH_APPLIED = False
VIDEO_AWEME_TYPES = {0, 55, 61, 109, 163, 201}
IMAGE_AWEME_TYPES = {68}


def _clean_url_list(url_list):
    if not isinstance(url_list, list):
        return None

    cleaned = [
        value.strip()
        for value in url_list
        if isinstance(value, str) and value.strip()
    ]
    return cleaned or None


def _first_url(value):
    if isinstance(value, str) and value.strip():
        return value.strip()

    if isinstance(value, dict):
        url_list = _clean_url_list(value.get("url_list"))
        if url_list:
            return url_list[0]

    return None


def _parse_json_text(raw_text):
    if not raw_text:
        return {}

    if isinstance(raw_text, dict):
        return raw_text

    if not isinstance(raw_text, str):
        return {}

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return {}

    return parsed if isinstance(parsed, dict) else {}


def _extract_video_url_list(video_data):
    if not isinstance(video_data, dict):
        return None

    bit_rate = video_data.get("bit_rate")
    if isinstance(bit_rate, list):
        for item in bit_rate:
            if not isinstance(item, dict):
                continue
            url_list = _clean_url_list((item.get("play_addr") or {}).get("url_list"))
            if url_list:
                return url_list
    elif isinstance(bit_rate, dict):
        url_list = _clean_url_list((bit_rate.get("play_addr") or {}).get("url_list"))
        if url_list:
            return url_list

    return _clean_url_list((video_data.get("play_addr") or {}).get("url_list"))


def _extract_cover_url(video_data):
    if not isinstance(video_data, dict):
        return None

    for key in ("origin_cover", "cover", "animated_cover"):
        url_list = _clean_url_list((video_data.get(key) or {}).get("url_list"))
        if url_list:
            return url_list[0]

    return None


def _extract_image_urls(image_list):
    if not isinstance(image_list, list):
        return None

    urls = []

    for image_data in image_list:
        if not isinstance(image_data, dict):
            continue

        candidates = (
            image_data,
            image_data.get("display_image"),
            image_data.get("origin_url"),
            image_data.get("download_url"),
            image_data.get("large"),
            image_data.get("medium"),
            image_data.get("thumb"),
        )

        image_url = None
        for candidate in candidates:
            image_url = _first_url(candidate)
            if image_url:
                break

        if image_url:
            urls.append(image_url)

    return urls or None


def _extract_live_photo_urls(image_list):
    if not isinstance(image_list, list):
        return None

    urls = []

    for image_data in image_list:
        if not isinstance(image_data, dict):
            continue

        video_data = image_data.get("video")
        video_urls = _extract_video_url_list(video_data)
        if video_urls:
            urls.append(video_urls[0])

    return urls or None


def _entry_image_list(entry):
    for key in ("images", "image_list", "original_images", "image_infos"):
        value = entry.get(key)
        if isinstance(value, list):
            return value
    return None


def _extract_article_parts(entry):
    article_info = entry.get("article_info")
    if not isinstance(article_info, dict):
        return {}, {}, {}

    article_content = _parse_json_text(article_info.get("article_content"))
    fe_data = _parse_json_text(article_info.get("fe_data"))
    return article_info, article_content, fe_data


def build_article_markdown(entry):
    article_info, article_content, _ = _extract_article_parts(entry)
    markdown = article_content.get("markdown") or article_content.get(
        "long_article_abstract"
    )
    if not isinstance(markdown, str) or not markdown.strip():
        return None

    title = article_info.get("article_title") or entry.get("desc") or ""
    title = title.strip() if isinstance(title, str) else ""
    body = markdown.strip()

    if not title:
        return body

    return f"# {title}\n\n{body}"


def extract_article_cover(entry):
    article_info, _, fe_data = _extract_article_parts(entry)

    for candidate in (
        fe_data.get("head_poster_list"),
        {"url_list": [fe_data.get("pre_cover")]},
        (entry.get("video") or {}).get("origin_cover"),
        (entry.get("video") or {}).get("cover"),
        {"url_list": [article_info.get("pre_cover")]},
    ):
        cover_url = _first_url(candidate)
        if cover_url:
            return cover_url

    return None


def extract_article_images(entry):
    _, _, fe_data = _extract_article_parts(entry)
    image_list = fe_data.get("image_list")
    return _extract_image_urls(image_list)


def extract_entry_video_url_list(entry):
    return _extract_video_url_list(entry.get("video"))


def extract_entry_cover_url(entry):
    return _extract_cover_url(entry.get("video"))


def extract_entry_image_urls(entry):
    return _extract_image_urls(_entry_image_list(entry))


def extract_entry_live_photo_urls(entry):
    return _extract_live_photo_urls(_entry_image_list(entry))


def has_any_url(value):
    if isinstance(value, str):
        return bool(value.strip())

    if isinstance(value, list):
        for item in value:
            if has_any_url(item):
                return True
        return False

    return False


def select_download_kind(aweme_data):
    if has_any_url(aweme_data.get("article_images")) or aweme_data.get(
        "article_markdown"
    ):
        return "article"

    if has_any_url(aweme_data.get("video_play_addr")) or aweme_data.get(
        "aweme_type"
    ) in VIDEO_AWEME_TYPES:
        return "video"

    if has_any_url(aweme_data.get("images")) or has_any_url(
        aweme_data.get("images_video")
    ) or aweme_data.get("aweme_type") in IMAGE_AWEME_TYPES:
        return "images"

    return "unknown"


def _list_property(entries_path, extractor):
    def getter(self):
        entries = self._get_attr_value(entries_path) or []
        return [extractor(entry if isinstance(entry, dict) else {}) for entry in entries]

    return property(getter)


def _detail_property(entry_path, extractor):
    def getter(self):
        entry = self._get_attr_value(entry_path) or {}
        entry = entry if isinstance(entry, dict) else {}
        return extractor(entry)

    return property(getter)


def apply_patch():
    global PATCH_APPLIED
    if PATCH_APPLIED:
        return

    from f2.apps.douyin.dl import DouyinDownloader
    from f2.apps.douyin.filter import FriendFeedFilter, PostDetailFilter, UserPostFilter
    from f2.apps.douyin.utils import format_file_name
    from f2.i18n.translator import _
    from f2.log.logger import logger

    def build_base_name(instance):
        return format_file_name(
            instance.kwargs.get("naming", "{create}_{desc}"),
            instance.aweme_data_dict,
        )

    async def download_article_markdown(self):
        article_markdown = self.aweme_data_dict.get("article_markdown")
        if not article_markdown:
            return

        await self.initiate_static_download(
            _("长文"),
            article_markdown,
            self.base_path,
            f"{build_base_name(self)}_article",
            ".md",
        )

    async def download_article_cover(self):
        article_cover = self.aweme_data_dict.get("article_cover")
        if not article_cover:
            return

        await self.initiate_download(
            _("文章封面"),
            article_cover,
            self.base_path,
            f"{build_base_name(self)}_article_cover",
            ".jpeg",
        )

    async def download_article_images(self):
        article_images = self.aweme_data_dict.get("article_images") or []

        for index, image_url in enumerate(article_images, start=1):
            if not image_url:
                continue

            await self.initiate_download(
                _("文章配图"),
                image_url,
                self.base_path,
                f"{build_base_name(self)}_article_image_{index}",
                ".jpeg",
            )

    async def patched_handler_download(self, kwargs, aweme_data_dict, user_path):
        self.base_path = (
            user_path
            / format_file_name(kwargs.get("naming", "{create}_{desc}"), aweme_data_dict)
            if kwargs.get("folderize")
            else user_path
        )

        self.sec_user_id = str(aweme_data_dict.get("sec_user_id"))
        self.aweme_id = str(aweme_data_dict.get("aweme_id"))
        self.kwargs = kwargs
        self.aweme_data_dict = aweme_data_dict

        aweme_prohibited = aweme_data_dict.get("is_prohibited")
        aweme_status = aweme_data_dict.get("private_status")
        aweme_type = aweme_data_dict.get("aweme_type")
        download_kind = select_download_kind(aweme_data_dict)

        if aweme_prohibited:
            logger.warning(_("[{0}] 该作品已被屏蔽，无法下载").format(self.aweme_id))
            return

        if aweme_status in [0, 1, 2]:
            optional_tasks = [
                ("music", self.download_music),
                ("desc", self.download_desc),
            ]

            if download_kind != "article":
                optional_tasks.insert(1, ("cover", self.download_cover))

            for task_name, task_func in optional_tasks:
                if self.kwargs.get(task_name):
                    await task_func()

            if download_kind == "article":
                await self.download_article_markdown()
                await self.download_article_cover()
                await self.download_article_images()
            elif download_kind == "video":
                await self.download_video()
            elif download_kind == "images":
                await self.download_images()
            else:
                logger.warning(
                    _("[{0}] 未找到可下载的作品内容，作品类型：{1}").format(
                        self.aweme_id, aweme_type
                    )
                )

        await self.save_last_aweme_id(self.sec_user_id, self.aweme_id)

    UserPostFilter.video_play_addr = _list_property(
        "$.aweme_list", extract_entry_video_url_list
    )
    UserPostFilter.cover = _list_property("$.aweme_list", extract_entry_cover_url)
    UserPostFilter.images = _list_property("$.aweme_list", extract_entry_image_urls)
    UserPostFilter.images_video = _list_property(
        "$.aweme_list", extract_entry_live_photo_urls
    )
    UserPostFilter.article_markdown = _list_property(
        "$.aweme_list", build_article_markdown
    )
    UserPostFilter.article_cover = _list_property(
        "$.aweme_list", extract_article_cover
    )
    UserPostFilter.article_images = _list_property(
        "$.aweme_list", extract_article_images
    )

    PostDetailFilter.video_play_addr = _detail_property(
        "$.aweme_detail", extract_entry_video_url_list
    )
    PostDetailFilter.cover = _detail_property("$.aweme_detail", extract_entry_cover_url)
    PostDetailFilter.images = _detail_property("$.aweme_detail", extract_entry_image_urls)
    PostDetailFilter.images_video = _detail_property(
        "$.aweme_detail", extract_entry_live_photo_urls
    )
    PostDetailFilter.article_markdown = _detail_property(
        "$.aweme_detail", build_article_markdown
    )
    PostDetailFilter.article_cover = _detail_property(
        "$.aweme_detail", extract_article_cover
    )
    PostDetailFilter.article_images = _detail_property(
        "$.aweme_detail", extract_article_images
    )

    FriendFeedFilter.video_play_addr = _list_property(
        "$.data[*].aweme", extract_entry_video_url_list
    )
    FriendFeedFilter.cover = _list_property("$.data[*].aweme", extract_entry_cover_url)
    FriendFeedFilter.images = _list_property("$.data[*].aweme", extract_entry_image_urls)
    FriendFeedFilter.images_video = _list_property(
        "$.data[*].aweme", extract_entry_live_photo_urls
    )
    FriendFeedFilter.article_markdown = _list_property(
        "$.data[*].aweme", build_article_markdown
    )
    FriendFeedFilter.article_cover = _list_property(
        "$.data[*].aweme", extract_article_cover
    )
    FriendFeedFilter.article_images = _list_property(
        "$.data[*].aweme", extract_article_images
    )

    DouyinDownloader.download_article_markdown = download_article_markdown
    DouyinDownloader.download_article_cover = download_article_cover
    DouyinDownloader.download_article_images = download_article_images
    DouyinDownloader.handler_download = patched_handler_download

    PATCH_APPLIED = True

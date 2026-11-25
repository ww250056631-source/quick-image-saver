# 快存图片

Chrome 扩展。鼠标移到网页图片上即可快存，也可以从 B 站、YouTube 和 X 的视频详情页保存 MP4。

**[下载快存图片 v1.3.0（ZIP）](https://github.com/ww250056631-source/quick-image-saver/releases/download/v1.3.0/quick-image-saver-v1.3.0.zip)** · [查看发布记录](https://github.com/ww250056631-source/quick-image-saver/releases)

## 安装

1. 解压下载的 ZIP，找到包含 `manifest.json` 的 `quick-image-saver` 文件夹。
2. 在桌面版 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选中该文件夹。已有旧版时，可把新版文件覆盖到原安装目录，再点击「重新加载」。

## 使用

- **保存图片**　选择保存文件夹。鼠标移到图片上，点击「↓ 快存」。
- **保存视频**　首次在扩展弹窗开启「保存视频」。打开视频详情页，再点击「保存当前视频」。文件会保存到 Chrome 的下载位置。

v1.3.0 已用 B 站、YouTube 和 X 各一条公开视频验证有声 MP4 下载。另一个 YouTube 样例在测试中收到媒体服务器的 HTTP 403。可保存的画质和格式取决于站点提供的媒体。

[详细使用说明](quick-image-saver/README.md)

## 许可

扩展代码使用 [MIT 许可](LICENSE)。内置的 Mediabunny 使用 MPL 2.0，许可证及对应源码见 [第三方声明](quick-image-saver/vendor/NOTICE.md)。

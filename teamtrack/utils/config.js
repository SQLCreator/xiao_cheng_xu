/**
 * 全局配置
 *
 * WEB_UPLOAD_BASE：电脑端上传页地址，留空表示尚未开通。
 * 开通云开发「静态网站托管」后，把 web-upload/index.html 部署到站点根目录，
 * 再把访问域名填到这里（不要带结尾斜杠），例如：
 *   WEB_UPLOAD_BASE: 'https://cloud1-d8g501yg926149990.tcloudbaseapp.com'
 * 小程序会把该地址拼上 ?code=上传码 交给用户复制到电脑浏览器打开。
 */
module.exports = {
  WEB_UPLOAD_BASE: ''
}
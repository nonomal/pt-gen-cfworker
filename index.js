const cheerio = require("cheerio");  // HTML页面解析
const HTML2BBCode = require("html2bbcode").HTML2BBCode;

/**
 * Cloudflare Worker entrypoint
 */
addEventListener("fetch", event => {
  event.respondWith(handle(event));
});

// 常量定义
const author_ = "Rhilip";
const version_ = "0.4.9";

const support_list = {
  // 注意value值中正则的分组只能有一个，而且必须是sid信息，其他分组必须设置不捕获属性
  "douban": /(?:https?:\/\/)?(?:(?:movie|www)\.)?douban\.com\/(?:subject|movie)\/(\d+)\/?/,
  "imdb": /(?:https?:\/\/)?(?:www\.)?imdb\.com\/title\/(tt\d+)\/?/,
  "bangumi": /(?:https?:\/\/)?(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/(\d+)\/?/,
  "steam": /(?:https?:\/\/)?(?:store\.)?steam(?:powered|community)\.com\/app\/(\d+)\/?/,
  "indienova": /(?:https?:\/\/)?indienova\.com\/game\/(\S+)/,
  "epic": /(?:https?:\/\/)?www\.epicgames\.com\/store\/[a-z]{2}-[A-Z]{2}\/product\/(\S+)\/\S?/
};

const support_site_list = Object.keys(support_list);

const douban_apikey_list = [
  "02646d3fb69a52ff072d47bf23cef8fd",
  "0b2bdeda43b5688921839c8ecb20399b",
  "0dad551ec0f84ed02907ff5c42e8ec70",
  "0df993c66c0c636e29ecbb5344252a4a",
  "07c78782db00a121175696889101e363"
];

/** 公有的JSON字段，其他字段为不同生成模块的信息
 *  考虑到历史兼容的问题，应该把所有字段都放在顶层字典
 *  （虽然说最好的实践是放在 root.data 里面
 */
const default_body = {
  "success": false,   // 请求是否成功，客户端应该首先检查该字段
  "error": null,      // 如果请求失败，此处为失败原因
  "format": "",       // 使用BBCode格式整理的简介
  "copyright": `Powered by @${author_}`,   // 版权信息
  "version": version_,   // 版本
  "generate_at": 0   // 生成时间（毫秒级时间戳），可以通过这个值与当前时间戳比较判断缓存是否应该过期
};

const NONE_EXIST_ERROR = "The corresponding resource does not exist.";

/**
 * Fetch and log a request
 * @param {Event} event
 */
async function handle(event) {
  const request = event.request;  // 获取请求

  // 检查缓存，命中则直接返回
  const cache = caches.default;  // 定义缓存
  let response = await cache.match(request);

  if (!response) {
    // 使用URI() 解析request.url
    let uri = new URL(request.url);

    // 不存在任何请求字段，返回默认页面
    if (uri.search == '') { 
      response = makeIndexResponse();
    } else {
      let site, sid;

      // 请求字段 `&url=` 存在
      if (uri.searchParams.get("url")) {
        let url_ = uri.searchParams.get("url");
        for (let site_ in support_list) {
          let pattern = support_list[site_];
          if (url_.match(pattern)) {
            site = site_;
            sid = url_.match(pattern)[1];
            break;
          }
        }
      } else {
        site = uri.searchParams.get("site");
        sid = uri.searchParams.get("sid");
      }
  
      try {
        // 如果site和sid不存在的话，提前返回
        if (site == null || sid == null) {
          response = makeJsonResponse({ error: "Miss key of `site` or `sid` , or input unsupported resource `url`." });
        } else {
          if (support_site_list.includes(site)) {
            // 进入对应资源站点处理流程
            if (site === "douban") {
              response = await gen_douban(sid);
            } else if (site === "imdb") {
              response = await gen_imdb(sid);
            } else if (site === "bangumi") {
              response = await gen_bangumi(sid);
            } else if (site === "steam") {
              response = await gen_steam(sid);
            } else if (site === "indienova") {
              response = await gen_indienova(sid);
            } else if (site === "epic") {
              response = await gen_epic(sid);
            } else {
              // 没有对应方法的资源站点，（真的会有这种情况吗？
              response = makeJsonResponse({ error: "Miss generate function for `site`: " + site + "." });
            }
          } else {
            response = makeJsonResponse({ error: "Unknown value of key `site`." });
          }
        }
        // 添加缓存 （ 此处如果response如果为undefined的话会抛出错误
        event.waitUntil(cache.put(request, response.clone()));
      } catch (e) {
        response = makeJsonResponse({ error: `Internal Error, Please contact @${author_}. Exception: ${e.message}` });
        // 当发生Internal Error的时候不应该进行cache
      }
    }

  }

  return response;
}

//-    辅助方法      -//

// 返回Json请求
function makeJsonResponse(body_update) {
  let body = Object.assign(
    {},
    default_body,
    body_update,
    { generate_at: (new Date()).valueOf() }
  );
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"   // CORS
    }
  });
}

// 解析HTML页面
function page_parser(responseText) {
  return cheerio.load(responseText, { decodeEntities: false });
}

// 解析JSONP返回
function jsonp_parser(responseText) {
  responseText = responseText.match(/[^(]+\((.+)\)/)[1];
  return JSON.parse(responseText);
}

// Html2bbcode
function html2bbcode(html) {
  let converter = new HTML2BBCode();
  let bbcode = converter.feed(html);
  return bbcode.toString();
}

// 从前面定义的douban_apikey_list中随机取一个来使用
function getDoubanApiKey() {
  return douban_apikey_list[
    Math.floor(Math.random() * douban_apikey_list.length)
    ];
}

function getNumberFromString(raw) {
  return (raw.match(/[\d,]+/) || [0])[0].replace(/,/g, "");
}

// 各个资源站点的相应请求整理方法，统一使用async function
async function gen_douban(sid) {
  let data = { site: "douban", sid: sid };
  // 先处理douban上的imdb信息
  if (sid.startsWith("tt")) {
    let douban_imdb_api = await fetch(`https://api.douban.com/v2/movie/imdb/${sid}?apikey=${getDoubanApiKey()}`);
    let db_imdb_api_resp = await douban_imdb_api.json();
    let new_url = db_imdb_api_resp.alt;
    if (new_url) {
      let new_group = new_url.match(support_list.douban);
      if (new_group && !new_group[1].startsWith("tt")) {
        sid = new_group[1];   // 重写sid到豆瓣对应的值
      }
    }

    // 重新检查重写操作是否正常
    if (sid.startsWith("tt")) {
      return makeJsonResponse({ error: `Can't find this imdb_id(${sid}) in Douban.` });
    }
  }

  // 下面开始正常的豆瓣处理流程
  let douban_link = `https://movie.douban.com/subject/${sid}/`;
  let [db_page_resp, db_api_resp, awards_page_resp] = await Promise.all([
    fetch(`https://movie.douban.com/subject/${sid}/`),  // 豆瓣主页面
    fetch(`https://api.douban.com/v2/movie/${sid}?apikey=${getDoubanApiKey()}`),   // 豆瓣api
    fetch(`https://movie.douban.com/subject/${sid}/awards`)  // 豆瓣获奖界面
  ]);

  let douban_page_raw = await db_page_resp.text();
  let douban_api_json = await db_api_resp.json();

  // 对异常进行处理
  if (douban_api_json.msg) {
    return makeJsonResponse(Object.assign(data, { error: douban_api_json.msg }));
  } else if (douban_page_raw.match(/检测到有异常请求/)) {  // 真的会有这种可能吗？
    return makeJsonResponse(Object.assign(data, { error: "GenHelp was temporary banned by Douban, Please wait." }));
  } else {
    // 解析页面
    let $ = page_parser(douban_page_raw);

    let title = $("title").text().replace("(豆瓣)", "").trim();
    if (title.match(/页面不存在/)) {
      return makeJsonResponse(Object.assign(data, { error: NONE_EXIST_ERROR }));  // FIXME 此时可能页面只是隐藏，而不是不存在，需要根据json信息进一步判断
    }

    // 元素获取方法
    let fetch_anchor = function(anchor) {
      return anchor[0].nextSibling.nodeValue.trim();
    };

    // 所有需要的元素
    let poster;
    let this_title, trans_title, aka;
    let year, region, genre, language, playdate;
    let imdb_link, imdb_id, imdb_average_rating, imdb_votes, imdb_rating;
    let douban_average_rating, douban_votes, douban_rating;
    let episodes, duration;
    let director, writer, cast;
    let tags, introduction, awards;

    // 提前imdb相关请求
    let imdb_link_anchor = $("div#info a[href*='://www.imdb.com/title/tt']");
    let has_imdb = imdb_link_anchor.length > 0;
    if (has_imdb) {
      data["imdb_link"] = imdb_link = imdb_link_anchor.attr("href").replace(/(\/)?$/, "/").replace("http://", "https://");
      data["imdb_id"] = imdb_id = imdb_link.match(/tt\d+/)[0];
      let imdb_api_resp = await fetch(`https://p.media-imdb.com/static-content/documents/v1/title/${imdb_id}/ratings%3Fjsonp=imdb.rating.run:imdb.api.title.ratings/data.json`);
      let imdb_api_raw = await imdb_api_resp.text();
      let imdb_json = jsonp_parser(imdb_api_raw);

      imdb_average_rating = imdb_json["resource"]["rating"];
      imdb_votes = imdb_json["resource"]["ratingCount"];
      if (imdb_average_rating && imdb_votes) {
        data["imdb_rating"] = imdb_rating = `${imdb_average_rating}/10 from ${imdb_votes} users`;
      }
    }
    
    let chinese_title = data["chinese_title"] = title;
    let foreign_title = data["foreign_title"] = $("span[property=\"v:itemreviewed\"]").text().replace(data["chinese_title"], "").trim();

    let aka_anchor = $("#info span.pl:contains(\"又名\")");
    if (aka_anchor.length > 0) {
      aka = fetch_anchor(aka_anchor).split(" / ").sort(function(a, b) {  //首字(母)排序
        return a.localeCompare(b);
      }).join("/");
      data["aka"] = aka.split("/");
    }

    if (foreign_title) {
      trans_title = chinese_title + (aka ? ("/" + aka) : "");
      this_title = foreign_title;
    } else {
      trans_title = aka ? aka : "";
      this_title = chinese_title;
    }

    data["trans_title"] = trans_title.split("/");
    data["this_title"] = this_title.split("/");

    let regions_anchor = $("#info span.pl:contains(\"制片国家/地区\")");  //产地
    let language_anchor = $("#info span.pl:contains(\"语言\")");  //语言
    let episodes_anchor = $("#info span.pl:contains(\"集数\")");  //集数
    let duration_anchor = $("#info span.pl:contains(\"单集片长\")");  //片长

    data["year"] = year = " " + $("#content > h1 > span.year").text().substr(1, 4);
    data["region"] = region = regions_anchor[0] ? fetch_anchor(regions_anchor).split(" / ") : "";

    data["genre"] = genre = $("#info span[property=\"v:genre\"]").map(function() {  //类别
      return $(this).text().trim();
    }).toArray();

    data["language"] = language = language_anchor[0] ? fetch_anchor(language_anchor).split(" / ") : "";

    data["playdate"] = playdate = $("#info span[property=\"v:initialReleaseDate\"]").map(function() {   //上映日期
      return $(this).text().trim();
    }).toArray().sort(function(a, b) {//按上映日期升序排列
      return new Date(a) - new Date(b);
    });

    data["episodes"] = episodes = episodes_anchor[0] ? fetch_anchor(episodes_anchor) : "";
    data["duration"] = duration = duration_anchor[0] ? fetch_anchor(duration_anchor) : $("#info span[property=\"v:runtime\"]").text().trim();

    let awards_page_raw = await awards_page_resp.text();
    let awards_page = page_parser(awards_page_raw);
    data["awards"] = awards = awards_page("#content > div > div.article").html()
      .replace(/[ \n]/g, "")
      .replace(/<\/li><li>/g, "</li> <li>")
      .replace(/<\/a><span/g, "</a> <span")
      .replace(/<(div|ul)[^>]*>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/ +\n/g, "\n")
      .trim();

    data["douban_rating_average"] = douban_average_rating = douban_api_json["rating"]["average"] || 0;
    data["douban_votes"] = douban_votes = douban_api_json["rating"]["numRaters"].toLocaleString() || 0;
    data["douban_rating"] = douban_rating = `${douban_average_rating}/10 from ${douban_votes} users`;

    data["introduction"] = introduction = douban_api_json.summary.replace(/^None$/g, "暂无相关剧情介绍");
    data["poster"] = poster = douban_api_json.image.replace(/s(_ratio_poster|pic)/g, "l")
      .replace("img3", "img1");

    data["director"] = director = douban_api_json.attrs.director ? douban_api_json.attrs.director.join(" / ") : "";
    data["writer"] = writer = douban_api_json.attrs.writer ? douban_api_json.attrs.writer.join(" / ") : "";
    data["cast"] = cast = douban_api_json.attrs.cast ? douban_api_json.attrs.cast.join("\n") : "";
    data["tags"] = tags = douban_api_json.tags.map(function(member) {
      return member.name;
    });

    // 生成format
    let descr = poster ? `[img]${poster}[/img]\n\n` : "";
    descr += trans_title ? `◎译　　名　${trans_title}\n` : "";
    descr += this_title ? `◎片　　名　${this_title}\n` : "";
    descr += year ? `◎年　　代　${year.trim()}\n` : "";
    descr += region ? `◎产　　地　${region}\n` : "";
    descr += genre ? `◎类　　别　${genre.join(" / ")}\n` : "";
    descr += language ? `◎语　　言　${language}\n` : "";
    descr += playdate ? `◎上映日期　${playdate.join(" / ")}\n` : "";
    descr += imdb_rating ? `◎IMDb评分  ${imdb_rating}\n` : "";
    descr += imdb_link ? `◎IMDb链接  ${imdb_link}\n` : "";
    descr += douban_rating ? `◎豆瓣评分　${douban_rating}\n` : "";
    descr += douban_link ? `◎豆瓣链接　${douban_link}\n` : "";
    descr += episodes ? `◎集　　数　${episodes}\n` : "";
    descr += duration ? `◎片　　长　${duration}\n` : "";
    descr += director ? `◎导　　演　${director}\n` : "";
    descr += writer ? `◎编　　剧　${writer}\n` : "";
    descr += cast ? `◎主　　演　${cast.replace(/\n/g, "\n" + "　".repeat(4) + "  　").trim()}\n` : "";
    descr += tags ? `\n◎标　　签　${tags.join(" | ")}\n` : "";
    descr += introduction ? `\n◎简　　介\n\n　　${introduction.replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";
    descr += awards ? `\n◎获奖情况\n\n　　${awards.replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";

    data["format"] = descr.trim();
    data["success"] = true;  // 更新状态为成功
    return makeJsonResponse(data);
  }
}

async function gen_imdb(sid) {
  let data = { site: "imdb", sid: sid };
  // 处理imdb_id tt\d{7,8} 或者 \d{0,8}
  if (sid.startsWith("tt")) {
    sid = sid.slice(2);
  }

  // 不足7位补齐到7位，如果是7、8位则直接使用
  let imdb_id = "tt" + sid.padStart(7, "0");
  let imdb_url = `https://www.imdb.com/title/${imdb_id}/`;
  let [imdb_page_resp, imdb_release_info_page_resp] = await Promise.all([
    fetch(imdb_url),
    fetch(`https://www.imdb.com/title/${imdb_id}/releaseinfo`)
  ]);

  let imdb_page_raw = await imdb_page_resp.text();

  if (imdb_page_raw.match(/404 Error - IMDb/)) {
    return makeJsonResponse(Object.assign(data, { error: NONE_EXIST_ERROR }));
  }

  let $ = page_parser(imdb_page_raw);

  // 首先解析页面中的json信息，并从中获取数据  `<script type="application/ld+json">...</script>`
  let page_json = JSON.parse(
    imdb_page_raw.match(/<script type="application\/ld\+json">([\S\s]+?)<\/script>/)[1]
      .replace(/\n/g, "")
  );

  data["imdb_id"] = imdb_id;
  data["imdb_link"] = imdb_url;

  // 处理可以直接从page_json中复制过来的信息
  let copy_items = ["@type", "name", "genre", "contentRating", "datePublished", "description", "duration"];
  for (let i = 0; i < copy_items.length; i++) {
    let copy_item = copy_items[i];
    data[copy_item] = page_json[copy_item];
  }

  data["poster"] = page_json["image"];

  if (data["datePublished"]) {
    data["year"] = data["datePublished"].slice(0, 4);
  }

  let person_items = ["actor", "director", "creator"];
  for (let i = 0; i < person_items.length; i++) {
    let person_item = person_items[i];
    let raw = page_json[person_item];

    if (!raw) continue;   // 没有对应直接直接进入下一轮

    // 有时候这个可能为一个dict而不是dict array
    if (!Array.isArray(raw)) {
      raw = [raw];
    }

    // 只要人的（Person），不要组织的（Organization）
    let item_persons = raw.filter((d) => {
      return d["@type"] === "Person";
    });

    if (item_persons.length > 0) {
      data[person_item + "s"] = item_persons.map((d) => {
        delete d["@type"];
        return d;
      });
    }
  }

  data["keywords"] = page_json["keywords"].split(",");
  let aggregate_rating = page_json["aggregateRating"] || {};

  data["imdb_votes"] = aggregate_rating["ratingCount"] || 0;
  data["imdb_rating_average"] = aggregate_rating["ratingValue"] || 0;
  data["imdb_rating"] = `${data["imdb_votes"]}/10 from ${data["imdb_rating_average"]} users`;

  // 解析页面元素
  // 第一部分： Metascore，Reviews，Popularity
  let mrp_bar = $("div.titleReviewBar > div.titleReviewBarItem");
  mrp_bar.each(function() {
    let that = $(this);
    if (that.text().match(/Metascore/)) {
      let metascore_another = that.find("div.metacriticScore");
      if (metascore_another) data["metascore"] = metascore_another.text().trim();
    } else if (that.text().match(/Reviews/)) {
      let reviews_another = that.find("a[href^=reviews]");
      let critic_another = that.find("a[href^=externalreviews]");
      if (reviews_another) data["reviews"] = getNumberFromString(reviews_another.text());
      if (critic_another) data["critic"] = getNumberFromString(critic_another.text());
    } else if (that.text().match(/Popularity/)) {
      data["popularity"] = getNumberFromString(that.text());
    }
  });

  // 第二部分： Details
  let details_another = $("div#titleDetails");
  let title_anothers = details_another.find("div.txt-block");
  let details_dict = {};
  title_anothers.each(function() {
    let title_raw = $(this).text().replace(/\n/ig, " ").replace(/See more »|Show more on {3}IMDbPro »/g, "").trim();
    if (title_raw.length > 0) {
      let title_key = title_raw.split(/: ?/, 1)[0];
      details_dict[title_key] = title_raw.replace(title_key + ":", "").replace(/ {2,}/g, " ").trim();
    }
  });
  data["details"] = details_dict;

  // 请求附属信息
  // 第一部分： releaseinfo
  let imdb_release_info_raw = await imdb_release_info_page_resp.text();
  let imdb_release_info = page_parser(imdb_release_info_raw);

  let release_date_items = imdb_release_info("tr.release-date-item");
  let release_date = [], aka = [];
  release_date_items.each(function() {
    let that = imdb_release_info(this);  // $(this) ?
    let country = that.find("td.release-date-item__country-name");
    let date = that.find("td.release-date-item__date");

    if (country && date) {
      release_date.push({ country: country.text().trim(), date: date.text().trim() });
    }
  });
  data["release_date"] = release_date;

  let aka_items = imdb_release_info("tr.aka-item");
  aka_items.each(function() {
    let that = imdb_release_info(this);
    let country = that.find("td.aka-item__name");
    let title = that.find("td.aka-item__title");

    if (country && title) {
      aka.push({ country: country.text().trim(), title: title.text().trim() });
    }
  });
  data["aka"] = aka;

  // 生成format
  let descr = (data["poster"] && data["poster"].length > 0) ? `[img]${data["poster"]}[/img]\n\n` : "";
  descr += (data["name"] && data["name"].length > 0) ? `Title: ${data["name"]}\n` : "";
  descr += (data["keywords"] && data["keywords"].length > 0) ? `Keywords: ${data["keywords"].join(", ")}\n` : "";
  descr += (data["datePublished"] && data["datePublished"].length > 0) ? `Date Published: ${data["datePublished"]}\n` : "";
  descr += (data["imdb_rating"] && data["imdb_rating"].length > 0) ? `IMDb Rating: ${data["imdb_rating"]}\n` : "";
  descr += (data["imdb_link"] && data["imdb_link"].length > 0) ? `IMDb Link: ${data["imdb_link"]}\n` : "";
  descr += (data["directors"] && data["directors"].length > 0) ? `Directors: ${data["directors"].map(i => i["name"]).join(" / ")}\n` : "";
  descr += (data["creators"] && data["creators"].length > 0) ? `Creators: ${data["creators"].map(i => i["name"]).join(" / ")}\n` : "";
  descr += (data["actors"] && data["actors"].length > 0) ? `Actors: ${data["actors"].map(i => i["name"]).join(" / ")}\n` : "";
  descr += (data["description"] && data["description"].length > 0) ? `\nIntroduction\n    ${data["description"].replace(/\n/g, "\n" + "　".repeat(2))}\n` : "";

  data["format"] = descr.trim();
  data["success"] = true;  // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_bangumi(sid) {
  let data = { site: "bangumi", sid: sid };

  // 请求页面
  let bangumi_link = `https://bgm.tv/subject/${sid}`;
  let [bangumi_page_resp, bangumi_characters_resp] = await Promise.all([
    fetch(bangumi_link),
    fetch(`https://bgm.tv/subject/${sid}/characters`)
  ]);

  let bangumi_page_raw = await bangumi_page_resp.text();

  if (bangumi_page_raw.match(/呜咕，出错了/)) {
    return makeJsonResponse(Object.assign(data, { error: NONE_EXIST_ERROR }));
  }

  data["alt"] = bangumi_link;
  let $ = page_parser(bangumi_page_raw);

  // 对页面进行划区
  let cover_staff_another = $("div#bangumiInfo");
  let cover_another = cover_staff_another.find("a.thickbox.cover");
  let staff_another = cover_staff_another.find("ul#infobox");
  let story_another = $("div#subject_summary");
  // let cast_another = $('div#browserItemList');

  /*  data['cover'] 为向前兼容项，之后均用 poster 表示海报
   *  这里有个问题，就是仍按 img.attr('src') 会取不到值因为 cf-worker中fetch 返回的html片段如下 ： https://pastebin.com/0wPLAf8t
   *  暂时不明白是因为 cf-worker 的问题还是 cf-CDN 的问题，因为直接源代码审查未发现该片段。
   */
  data["cover"] = data["poster"] = cover_another ? ("https:" + cover_another.attr("href")).replace(/\/cover\/[lcmsg]\//, "/cover/l/") : "";
  data["story"] = story_another ? story_another.text().trim() : "";
  data["staff"] = staff_another.find("li").map(function() {
      return $(this).text();
    }).get();

  let bangumi_characters_page_raw = await bangumi_characters_resp.text();
  let bangumi_characters_page = page_parser(bangumi_characters_page_raw);
  let cast_actors = bangumi_characters_page("div#columnInSubjectA > div.light_odd > div.clearit");

  data["cast"] = cast_actors.map(function() {
      let tag = bangumi_characters_page(this);
      let h2 = tag.find("h2");
      let char = (h2.find("span.tip").text() || h2.find("a").text()).replace(/\//, "").trim();
      let cv = tag.find("div.clearit > p").map(function() {
        let p = bangumi_characters_page(this);
        return (p.find("small") || p.find("a")).text().trim();
      }).get().join("，");
      return `${char}: ${cv}`;
    }).get();

  // 生成format
  let descr = (data["poster"] && data["poster"].length > 0) ? `[img]${data["poster"]}[/img]\n\n` : "";
  descr += (data["story"] && data["story"].length > 0) ? `[b]Story: [/b]\n\n${data["story"]}\n\n` : "";
  // 读取第4-19x  （假定bgm的顺序为中文名、话数、放送开始、放送星期...，对新番适用，较老番组可能不好  ，staff从第四个 导演 起算）
  descr += (data["staff"] && data["staff"].length > 0) ? `[b]Staff: [/b]\n\n${data["staff"].slice(4, 4 + 15).join("\n")}\n\n` : "";
  // 读取前9项cast信息
  descr += (data["cast"] && data["cast"].length > 0) ? `[b]Cast: [/b]\n\n${data["cast"].slice(0, 9).join("\n")}\n\n` : "";
  descr += (data["alt"] && data["alt"].length > 0) ? `(来源于 ${data["alt"]} )\n` : "";

  data["format"] = descr.trim();
  data["success"] = true;  // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_steam(sid) {
  let data = { site: "steam", sid: sid };

  let [steam_page_resp, steamcn_api_resp] = await Promise.all([
    fetch(`https://store.steampowered.com/app/${sid}/?l=schinese`, {
      headers: {  // 使用Cookies绕过年龄检查和成人内容提示，并强制中文
        "Cookies": "lastagecheckage=1-January-1975; birthtime=157737601; mature_content=1; wants_mature_content=1; Steam_Language=schinese"
      }
    }),
    fetch(`https://steamdb.steamcn.com/app/${sid}/data.js?v=38`)
  ]);

  let steam_page_raw = await steam_page_resp.text();

  // 不存在的资源会被302到首页，故检查标题
  if (steam_page_raw.match(/<title>(欢迎来到|Welcome to) Steam<\/title>/)) {
    return makeJsonResponse(Object.assign(data, { error: NONE_EXIST_ERROR }));
  }

  data["steam_id"] = sid;

  let steamcn_api_jsonp = await steamcn_api_resp.text();
  let steamcn_api_json = jsonp_parser(steamcn_api_jsonp);
  if (steamcn_api_json["name_cn"]) data["name_chs"] = steamcn_api_json["name_cn"];

  let $ = page_parser(steam_page_raw);

  // 从网页中定位数据
  let name_anchor = $("div.apphub_AppName") || $("span[itemprop=\"name\"]");  // 游戏名
  let cover_anchor = $("img.game_header_image_full[src]");  // 游戏封面图
  let detail_anchor = $("div.details_block");  // 游戏基本信息
  let linkbar_anchor = $("a.linkbar"); // 官网
  let language_anchor = $("table.game_language_options tr[class!=unsupported]");  // 支持语言
  let tag_anchor = $("a.app_tag");  // 标签
  let rate_anchor = $("div.user_reviews_summary_row");  // 游戏评价
  let descr_anchor = $("div#game_area_description");  // 游戏简介
  let sysreq_anchor = $("div.sysreq_contents > div.game_area_sys_req");  // 系统需求
  let screenshot_anchor = $("div.screenshot_holder a");  // 游戏截图

  data["cover"] = data["poster"] = cover_anchor ? cover_anchor.attr("src").replace(/^(.+?)(\?t=\d+)?$/, "$1") : "";
  data["name"] = name_anchor ? name_anchor.text().trim() : "";
  data["detail"] = detail_anchor ?
    detail_anchor.eq(0).text()
      .replace(/:[ 	\n]+/g, ": ")
      .split("\n")
      .map(x => x.trim())
      .filter(x => x.length > 0)
      .join("\n") : "";
  data["tags"] = tag_anchor ? tag_anchor.map(function() {
    return $(this).text().trim();
  }).get() : [];
  data["review"] = rate_anchor ? rate_anchor.map(function() {
    return $(this).text().replace("：", ":").replace(/[ 	\n]{2,}/ig, " ").trim();
  }).get() : [];
  if (linkbar_anchor && linkbar_anchor.text().search("访问网站")) {
    data["linkbar"] = linkbar_anchor.attr("href").replace(/^.+?url=(.+)$/, "$1");
  }

  const lag_checkcol_list = ["界面", "完全音频", "字幕"];
  data["language"] = language_anchor ?
    language_anchor
      .slice(1, 4)  // 不要首行，不要不支持行 外的前三行
      .map(function() {
        let tag = $(this);
        let tag_td_list = tag.find("td");
        let lag_support_checkcol = [];
        let lag = tag_td_list.eq(0).text().trim();

        for (let i = 0; i < lag_checkcol_list.length; i++) {
          let j = tag_td_list.eq(i + 1);
          if (j.text().search("✔")) {
            lag_support_checkcol.push(lag_checkcol_list[i]);
          }
        }

        return `${lag}${lag_support_checkcol.length > 0 ? ` (${lag_support_checkcol.join(", ")})` : ""}`;
      }).get() : [];

  data["descr"] = descr_anchor ? html2bbcode(descr_anchor.html()).replace("[h2]关于这款游戏[/h2]", "").trim() : "";
  data["screenshot"] = screenshot_anchor ? screenshot_anchor.map(function() {
    let dic = $(this);
    return dic.attr("href").replace(/^.+?url=(http.+?)\.[\dx]+(.+?)(\?t=\d+)?$/, "$1$2");
  }).get() : [];

  const os_dict = { "win": "Windows", "mac": "Mac OS X", "linux": "SteamOS + Linux" };
  data["sysreq"] = sysreq_anchor ? sysreq_anchor.map(function() {
    let tag = $(this);
    let os_type = os_dict[tag.attr("data-os")];

    let clone_tag = tag.clone();
    clone_tag.html(tag.html().replace(/<br>/ig, "[br]"));

    let sysreq_content = clone_tag
      .text()
      .split("\n").map(x => x.trim()).filter(x => x.length > 0).join("\n\n")  // 处理最低配置和最高配置之间的空白行
      .split("[br]").map(x => x.trim()).filter(x => x.length > 0).join("\n");  // 处理配置内的分行

    return `${os_type}\n${sysreq_content}`;
  }).get() : [];

  // 生成format
  let descr = (data["poster"] && data["poster"].length > 0) ? `[img]${data["poster"]}[/img]\n\n` : "";
  descr += "【基本信息】\n\n";  // 基本信息为原来的baseinfo块
  descr += (data["name_chs"] && data["name_chs"].length > 0) ? `中文名: ${data["name_chs"]}\n` : "";
  descr += (data["detail"] && data["detail"].length > 0) ? `${data["detail"]}\n` : "";
  descr += (data["linkbar"] && data["linkbar"].length > 0) ? `官方网站: ${data["linkbar"]}\n` : "";
  descr += (data["steam_id"] && data["steam_id"].length > 0) ? `Steam页面: https://store.steampowered.com/app/${data["steam_id"]}/\n` : "";
  descr += (data["language"] && data["language"].length > 0) ? `游戏语种: ${data["language"].join(" | ")}\n` : "";
  descr += (data["tags"] && data["tags"].length > 0) ? `标签: ${data["tags"].join(" | ")}\n` : "";
  descr += (data["review"] && data["review"].length > 0) ? `\n${data["review"].join("\n")}\n` : "";
  descr += "\n";
  descr += (data["descr"] && data["descr"].length > 0) ? `【游戏简介】\n\n${data["descr"]}\n\n` : "";
  descr += (data["sysreq"] && data["sysreq"].length > 0) ? `【配置需求】\n\n${data["sysreq"].join("\n")}\n\n` : "";
  descr += (data["screenshot"] && data["screenshot"].length > 0) ? `【游戏截图】\n\n${data["screenshot"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";

  data["format"] = descr.trim();
  data["success"] = true;  // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_indienova(sid) {
  let data = { site: "indienova", sid: sid };

  let [indienova_page_resp] = await Promise.all([
    fetch(`https://indienova.com/game/${sid}`)
  ]);

  let indienova_page_raw = await indienova_page_resp.text();

  // 检查标题看对应资源是否存在
  if (indienova_page_raw.match(/出现错误/)) {
    return makeJsonResponse(Object.assign(data, { error: NONE_EXIST_ERROR }));
  }

  let $ = page_parser(indienova_page_raw);

  data["poster"] = data["cover"] = $("div.cover-image img").attr("src");  // 提出封面链接
  data["chinese_title"] = $("title").text().split("|")[0].split("-")[0].trim();  // 提出标题部分

  let title_field = $("div.title-holder");  // 提取出副标部分
  data["another_title"] = title_field.find("h1 small") ? title_field.find("h1 small").text().trim() : "";
  data["english_title"] = title_field.find("h1 span") ? title_field.find("h1 span").text().trim() : "";
  data["release_date"] = title_field.find("p.gamedb-release").text().trim();

  // 提取链接信息
  let link_field = $("div#tabs-link a.gamedb-link");
  if (link_field.length > 0) {
    let links = {};
    link_field.each(function() {
      let that = $(this);
      let site = that.text().trim();
      links[site] = that.attr("href");
    });
    data["links"] = links;
  }

  // 提取简介、类型信息
  let intro_field = $("#tabs-intro");
  data["intro"] = intro_field.find("div.bottommargin-sm").text().trim();

  let tt = intro_field.find("p.single-line");
  if (tt.length > 0) {
    data["intro_detail"] = tt.map(function() {
      return $(this).text().replace(/[ \n]+/ig, " ").replace(/,/g, "/").trim();
    }).get();
  }

  // 提取详细介绍 在游戏无详细介绍时用简介代替
  let descr_field = $("article");
  data["descr"] = descr_field.length > 0 ? descr_field.text().replace("……显示全部", "").trim() : data["intro"];

  // 提取评分信息
  let rating_field = $("div#scores text").map(function() {
    return $(this).text();
  }).get();
  data["rate"] = `${rating_field[0]}:${rating_field[1]} / ${rating_field[2]}:${rating_field[3]}`;

  // 提取制作与发行商
  let pubdev = $("div#tabs-devpub ul[class^=\"db-companies\"]");
  data["dev"] = pubdev.eq(0).text().trim().split("\n").map(function(value, index, array) {
    return value.trim();
  });
  data["pub"] = pubdev.length === 2 ? pubdev.eq(1).text().trim().split("\n").map(function(value, index, array) {
    return value.trim();
  }) : [];

  // 提取图片列表
  data["screenshot"] = $("li.slide img").map(function() {
    return $(this).attr("src");
  }).get();

  // 提取标签信息
  let cat_field = $("div.indienova-tags.gamedb-tags");
  let cat = cat_field ? cat_field.text().trim().split("\n").map(x => x.trim()) : [];
  // 对cat进行去重并移除 "查看全部 +"
  data["cat"] = cat.filter(function(item, pos) {
    return cat.indexOf(item) === pos && item !== "查看全部 +";
  });

  // 提取分级信息
  let level_field = $("h4:contains(\"分级\") + div.bottommargin-sm");
  data["level"] = level_field ? level_field.find("img").map(function() {
    return $(this).attr("src");
  }).get() : [];

  // 提取价格信息
  let price_fields = $("ul.db-stores");
  data["price"] = price_fields ? price_fields.find("li").map(function() {
    let price_field = $(this).find("a > div");  // 里面依次为3个div，分别为 store, platform , price
    let store = price_field.eq(0).text().trim();
    //let platform = price_field.eq(1).text().trim();  // 均为图片，无内容
    let price = price_field.eq(2).text().trim().replace(/[ \n]{2,}/, " ");
    return `${store}：${price}`;
  }).get() : [];

  // 生成format
  let descr = data["cover"] ? `[img]${data["cover"]}[/img]\n\n` : "";
  descr += "【基本信息】\n\n";  // 基本信息为原来的baseinfo块
  descr += (data["chinese_title"] && data["chinese_title"].length > 0) ? `中文名称：${data["chinese_title"]}\n` : "";
  descr += (data["english_title"] && data["english_title"].length > 0) ? `英文名称：${data["english_title"]}\n` : "";
  descr += (data["another_title"] && data["another_title"].length > 0) ? `其他名称：${data["another_title"]}\n` : "";
  descr += (data["release_date"] && data["release_date"].length > 0) ? `发行时间：${data["release_date"]}\n` : "";
  descr += (data["rate"] && data["rate"].length > 0) ? `评分：${data["rate"]}\n` : "";
  descr += (data["dev"] && data["dev"].length > 0) ? `开发商：${data["dev"].join(" / ")}\n` : "";
  descr += (data["pub"] && data["pub"].length > 0) ? `发行商：${data["pub"].join(" / ")}\n` : "";
  descr += (data["intro_detail"] && data["intro_detail"].length > 0) ? `${data["intro_detail"].join("\n")}\n` : "";
  descr += (data["cat"] && data["cat"].length > 0) ? `标签：${data["cat"].slice(0, 8).join(" | ")}\n` : "";
  if ((data["links"] && data["links"].length > 0)) {
    let format_links = [];
    for (let [key, value] of Object.entries(data["links"])) {
      format_links.push(`[url=${value}]${key}[/url]`);
    }
    descr += `链接地址：${format_links.join("  ")}\n`;
  }
  descr += (data["price"] && data["price"].length > 0) ? `价格信息：${data["price"].join(" / ")}\n` : "";
  descr += "\n";
  descr += (data["descr"] && data["descr"].length > 0) ? `【游戏简介】\n\n${data["descr"]}\n\n` : "";
  descr += (data["screenshot"] && data["screenshot"].length > 0) ? `【游戏截图】\n\n${data["screenshot"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";
  descr += (data["level"] && data["level"].length > 0) ? `【游戏评级】\n\n${data["level"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";

  data["format"] = descr.trim();
  data["success"] = true;  // 更新状态为成功
  return makeJsonResponse(data);
}

async function gen_epic(sid) {
  let data = { site: "epic", sid: sid };

  let [epic_api_resp] = await Promise.all([
    fetch(`https://www.epicgames.com/store/zh-CN/api/content/products/${sid}`)
  ]);

  if ((await epic_api_resp.status) === 404) {  // 当接口返回404时内容不存在，200则继续解析
    return makeJsonResponse(Object.assign(data, { error: NONE_EXIST_ERROR }));
  }

  let epic_api_json = await epic_api_resp.json();

  // 从顶层字典中获得page
  let page = epic_api_json["pages"][0];

  data["name"] = page["productName"];  // 游戏名称
  data["epic_link"] = `https://www.epicgames.com/store${page["_urlPattern"]}`;  // 商店链接

  data["desc"] = page["data"]["about"]["description"];  // 游戏简介
  data["poster"] = data["logo"] = page["data"]["hero"]["logoImage"]["src"];  // 游戏logo
  data["screenshot"] = (page["data"]["gallery"]["galleryImages"] || []).map(x => x["src"]);  // 游戏截图

  // 语言 最低配置 推荐配置 评级
  let requirements = page["data"]["requirements"];
  data["language"] = requirements["languages"];

  data["min_req"] = {};
  data["max_req"] = {};
  requirements["systems"].forEach(function(i) {
    let systemType = i["systemType"];
    let details = i["details"];
    data["min_req"][systemType] = details.map(x => `${x["title"]}: ${x["minimum"]}`);
    data["max_req"][systemType] = details.map(x => `${x["title"]}: ${x["recommended"]}`);
  });
  data["level"] = requirements["legalTags"].map(x => x["src"]);

  // 生成format
  let descr = (data["logo"] && data["logo"].length > 0) ? `[img]${data["logo"]}[/img]\n\n` : "";
  descr += "【基本信息】\n\n";  // 基本信息为原来的baseinfo块
  descr += (data["name"] && data["name"].length > 0) ? `游戏名称：${data["name"]}\n` : "";
  descr += (data["epic_link"] && data["epic_link"].length > 0) ? `商店链接：${data["epic_link"]}\n` : "";
  descr += "\n";
  descr += (data["language"] && data["language"].length > 0) ? `【支持语言】\n\n${data["language"].join("\n")}\n\n` : "";
  descr += (data["desc"] && data["desc"].length > 0) ? `【游戏简介】\n\n${data["desc"]}\n\n` : "";

  let req_list = { "min_req": "【最低配置】", "max_req": "【推荐配置】" };
  for (let req in req_list) {
    if (Object.entries(data[req]).length === 0 && data[req].constructor === Object) continue;
    descr += `${req_list[req]}\n\n`;
    for (let system in data[req]) {
      descr += `${system}\n${data[req][system].join("\n")}\n`;
    }
    descr += "\n\n";
  }
  descr += (data["screenshot"] && data["screenshot"].length > 0) ? `【游戏截图】\n\n${data["screenshot"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";
  descr += (data["level"] && data["level"].length > 0) ? `【游戏评级】\n\n${data["level"].map(x => `[img]${x}[/img]`).join("\n")}\n\n` : "";

  data["format"] = descr.trim();
  data["success"] = true;  // 更新状态为成功
  return makeJsonResponse(data);
}

function makeIndexResponse() {
  return new Response(atob('PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KCjxoZWFkPgogICAgPG1ldGEgY2hhcnNldD0idXRmLTgiPgogICAgPG1ldGEgaHR0cC1lcXVpdj0iWC1VQS1Db21wYXRpYmxlIiBjb250ZW50PSJJRT1lZGdlIj4KICAgIDxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MSI+CgogICAgPG1ldGEgbmFtZT0iZGVzY3JpcHRpb24iIGNvbnRlbnQ9IlBUIEdlbiI+CiAgICA8bWV0YSBuYW1lPSJhdXRob3IiIGNvbnRlbnQ9IlJoaWxpcCI+CiAgICA8dGl0bGU+UFQgR2VuPC90aXRsZT4KCiAgICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vYm9vdHN0cmFwQDMuMy43L2Rpc3QvY3NzL2Jvb3RzdHJhcC5taW4uY3NzIgogICAgICAgIGludGVncml0eT0ic2hhMjU2LTkxNkViTWc3MFJReTlMSGlHa1h6RzhoU2c5RWROeTk3R2F6TkcvYWlZMXc9IiBjcm9zc29yaWdpbj0iYW5vbnltb3VzIj4KCiAgICA8c3R5bGUgdHlwZT0idGV4dC9jc3MiPgogICAgICAgIGJvZHkgewogICAgICAgICAgICBwYWRkaW5nLXRvcDogNTBweAogICAgICAgIH0KCiAgICAgICAgLm5hdmJhci1maXhlZC10b3AgewogICAgICAgICAgICBib3JkZXI6IDAKICAgICAgICB9CgogICAgICAgIC5tYWluIHsKICAgICAgICAgICAgcGFkZGluZzogMjBweDsKICAgICAgICAgICAgbWFyZ2luLXRvcDogMAogICAgICAgIH0KCiAgICAgICAgQG1lZGlhIChtaW4td2lkdGg6NzY4cHgpIHsKICAgICAgICAgICAgLm1haW4gewogICAgICAgICAgICAgICAgcGFkZGluZy1yaWdodDogNDBweDsKICAgICAgICAgICAgICAgIHBhZGRpbmctbGVmdDogNDBweAogICAgICAgICAgICB9CiAgICAgICAgfQoKICAgICAgICAjaW5wdXRfdmFsdWUgewogICAgICAgICAgICB3aWR0aDogNDgwcHgKICAgICAgICB9CgogICAgICAgIC56ZXJvLWNsaXBib2FyZCB7CiAgICAgICAgICAgIHBvc2l0aW9uOiByZWxhdGl2ZQogICAgICAgIH0KCiAgICAgICAgLmJ0bi1jbGlwYm9hcmQgewogICAgICAgICAgICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgICAgICAgICAgIHRvcDogOHB4OwogICAgICAgICAgICByaWdodDogMjFweDsKICAgICAgICAgICAgei1pbmRleDogMTA7CiAgICAgICAgICAgIGRpc3BsYXk6IGJsb2NrOwogICAgICAgICAgICBwYWRkaW5nOiA1cHggOHB4OwogICAgICAgICAgICBmb250LXNpemU6IDEycHg7CiAgICAgICAgICAgIGNvbG9yOiAjNzY3Njc2OwogICAgICAgICAgICBjdXJzb3I6IHBvaW50ZXI7CiAgICAgICAgICAgIGJhY2tncm91bmQtY29sb3I6ICNmZmY7CiAgICAgICAgICAgIGJvcmRlcjogMXB4IHNvbGlkICNlMWUxZTg7CiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDAgNHB4IDAgNHB4CiAgICAgICAgfQoKICAgICAgICB1bC50aW1lbGluZSB7CiAgICAgICAgICAgIGxpc3Qtc3R5bGUtdHlwZTogbm9uZTsKICAgICAgICAgICAgcG9zaXRpb246IHJlbGF0aXZlCiAgICAgICAgfQoKICAgICAgICB1bC50aW1lbGluZTpiZWZvcmUgewogICAgICAgICAgICBjb250ZW50OiAnICc7CiAgICAgICAgICAgIGJhY2tncm91bmQ6ICNkNGQ5ZGY7CiAgICAgICAgICAgIGRpc3BsYXk6IGlubGluZS1ibG9jazsKICAgICAgICAgICAgcG9zaXRpb246IGFic29sdXRlOwogICAgICAgICAgICBsZWZ0OiAyOXB4OwogICAgICAgICAgICB3aWR0aDogMnB4OwogICAgICAgICAgICBoZWlnaHQ6IDEwMCU7CiAgICAgICAgICAgIHotaW5kZXg6IDQwMAogICAgICAgIH0KCiAgICAgICAgdWwudGltZWxpbmU+bGkgewogICAgICAgICAgICBtYXJnaW46IDIwcHggMDsKICAgICAgICAgICAgcGFkZGluZy1sZWZ0OiAyMHB4CiAgICAgICAgfQoKICAgICAgICB1bC50aW1lbGluZT5saTpiZWZvcmUgewogICAgICAgICAgICBjb250ZW50OiAnICc7CiAgICAgICAgICAgIGJhY2tncm91bmQ6IHdoaXRlOwogICAgICAgICAgICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7CiAgICAgICAgICAgIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICAgICAgICAgICAgYm9yZGVyLXJhZGl1czogNTAlOwogICAgICAgICAgICBib3JkZXI6IDNweCBzb2xpZCAjMjJjMGU4OwogICAgICAgICAgICBsZWZ0OiAyMHB4OwogICAgICAgICAgICB3aWR0aDogMjBweDsKICAgICAgICAgICAgaGVpZ2h0OiAyMHB4OwogICAgICAgICAgICB6LWluZGV4OiA0MDAKICAgICAgICB9CiAgICA8L3N0eWxlPgoKICAgIDwhLS1baWYgbHQgSUUgOV0+CiAgICA8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS9odG1sNXNoaXZAMy43LjMvZGlzdC9odG1sNXNoaXYubWluLmpzIiBpbnRlZ3JpdHk9InNoYTI1Ni05dUFvTldIZHN6c1VEaFNYZi9yVmNXT3FLUGZpNS84VjVSNFVkYlpsZTJBPSIgY3Jvc3NvcmlnaW49ImFub255bW91cyI+PC9zY3JpcHQ+CiAgICA8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS9yZXNwb25kLmpzQDEuNC4yL2Rlc3QvcmVzcG9uZC5taW4uanMiIGludGVncml0eT0ic2hhMjU2LW53aHpXL1A5Z252V01QT204NE1LOEJ6UVJSTWRpOGl1dHhNdVlzWWNPZ3c9IiBjcm9zc29yaWdpbj0iYW5vbnltb3VzIj48L3NjcmlwdD4KICAgIDwhW2VuZGlmXS0tPgo8L2hlYWQ+Cgo8Ym9keT4KICAgIDxuYXYgY2xhc3M9Im5hdmJhciBuYXZiYXItaW52ZXJzZSBuYXZiYXItZml4ZWQtdG9wIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb250YWluZXItZmx1aWQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJuYXZiYXItaGVhZGVyIj4KICAgICAgICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0ibmF2YmFyLXRvZ2dsZSBjb2xsYXBzZWQiIGRhdGEtdG9nZ2xlPSJjb2xsYXBzZSIgZGF0YS10YXJnZXQ9IiNuYXZiYXIiCiAgICAgICAgICAgICAgICAgICAgYXJpYS1leHBhbmRlZD0iZmFsc2UiIGFyaWEtY29udHJvbHM9Im5hdmJhciI+CiAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9InNyLW9ubHkiPlRvZ2dsZSBuYXZpZ2F0aW9uPC9zcGFuPgogICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJpY29uLWJhciI+PC9zcGFuPgogICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJpY29uLWJhciI+PC9zcGFuPgogICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJpY29uLWJhciI+PC9zcGFuPgogICAgICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgICAgICA8YSBjbGFzcz0ibmF2YmFyLWJyYW5kIiBocmVmPSIjIj5QVCBHZW48L2E+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2IGlkPSJuYXZiYXIiIGNsYXNzPSJuYXZiYXItY29sbGFwc2UgY29sbGFwc2UiPgogICAgICAgICAgICAgICAgPHVsIGNsYXNzPSJuYXYgbmF2YmFyLW5hdiBuYXZiYXItcmlnaHQiPgogICAgICAgICAgICAgICAgICAgIDxsaT48YSBocmVmPSIvL2dpdGh1Yi5jb20vUmhpbGlwL1BULWhlbHAvYmxvYi9tYXN0ZXIvbW9kdWxlcy9pbmZvZ2VuL1JFQURNRS5tZCIKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldD0iX2JsYW5rIj5Eb2NzPC9hPgogICAgICAgICAgICAgICAgICAgIDwvbGk+CiAgICAgICAgICAgICAgICAgICAgPGxpPjxhIGhyZWY9Ii8vYmxvZy5yaGlsaXAuaW5mbyIgdGFyZ2V0PSJfYmxhbmsiPlBvd2VyZWQgQnkgQFJoaWxpcDwvYT48L2xpPgogICAgICAgICAgICAgICAgPC91bD4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICA8L25hdj4KICAgIDxkaXYgY2xhc3M9ImNvbnRhaW5lci1mbHVpZCBtYWluIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJjb2wtc20tOCBjb2wtc20tb2Zmc2V0LTIgY29sLW1kLTYgY29sLW1kLW9mZnNldC0zIj4KICAgICAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iZm9ybS1pbmxpbmUiPgogICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyb3VwIj4KICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0ic3Itb25seSIgZm9yPSJpbnB1dF92YWx1ZSI+SW5wdXQgdmFsdWU8L2xhYmVsPgogICAgICAgICAgICAgICAgICAgICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGNsYXNzPSJmb3JtLWNvbnRyb2wiCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGxhY2Vob2xkZXI9IuWQjeensOaIluixhueTo+OAgUlNRGLjgIFCYW5ndW1p44CBU3RlYW3jgIFpbmRpZW5vdmHjgIFFcGlj562J6LWE5rqQ6ZO+5o6lIiBpZD0iaW5wdXRfdmFsdWUiIC8+CiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXN1Y2Nlc3MiIGlkPSJxdWVyeV9idG4iPuafpeivojwvYnV0dG9uPgogICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJjaGVja2JveCIgaWQ9ImZvcmNlX2RvdWJhbl9kaXYiIHN0eWxlPSJkaXNwbGF5OiBub25lOyI+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8bGFiZWwgZm9yPSJmb3JjZV9kb3ViYW4iIGNsYXNzPSJjaGVja2JveCI+PC9sYWJlbD4KICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2xhc3M9ImZvcm0tY29udHJvbCIgaWQ9ImZvcmNlX2RvdWJhbiIgY2hlY2tlZD0iY2hlY2tlZCIgLz4g6YCa6L+H6LGG55Oj5p+l6K+iCiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICA8aHI+CiAgICAgICAgICAgICAgICA8ZGl2IGlkPSJnZW5faGVscCIgc3R5bGU9ImRpc3BsYXk6IG5vbmUiPjwvZGl2PgogICAgICAgICAgICAgICAgPGRpdiBpZD0iZ2VuX291dCI+CiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iemVyby1jbGlwYm9hcmQiPgogICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWNsaXBib2FyZCIgZGF0YS1jbGlwYm9hcmQtdGFyZ2V0PSIjbW92aWVfaW5mbyI+5aSN5Yi2PC9idXR0b24+CiAgICAgICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICAgICAgPHRleHRhcmVhIGNsYXNzPSJmb3JtLWNvbnRyb2wiIHJvd3M9MjIgaWQ9Im1vdmllX2luZm8iPjwvdGV4dGFyZWE+CiAgICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgICAgIDxocj4KICAgICAgICAgICAgICAgIDxocj4KICAgICAgICAgICAgICAgIDxkaXYgaWQ9Imdlbl9yZXBsYWNlIj4KICAgICAgICAgICAgICAgICAgICA8aDQ+55u45YWz5pu/5LujPC9oND4KICAgICAgICAgICAgICAgICAgICDmraTlpITliJflh7rlj6/ku6Xmm7/ku6PmnKzlubPlj7DnmoTlhbbku5blupTnlKjvvIzku6Xkvr/lnKggPGNvZGU+UHQtR2VuPC9jb2RlPiDlpLHmlYjmiJbov5Tlm57mlbDmja7pmYjml6fml7bkvb/nlKgKICAgICAgICAgICAgICAgICAgICA8dWwgc3R5bGU9Im1hcmdpbi10b3A6IDEwcHgiPgogICAgICAgICAgICAgICAgICAgICAgICA8bGk+PGI+PGEgaHJlZj0iaHR0cHM6Ly9naXRodWIuY29tL1JoaWxpcC9wdC1nZW4tY2Z3b3JrZXIiCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldD0iX2JsYW5rIj5SaGlsaXAvcHQtZ2VuLWNmd29ya2VyPC9hPjwvYj7vvJrmnoTlu7rlnKhDbG91ZGZsYXJlIFdvcmtlcuS4iueahFB0LUdlbuWIhuaUrzwvbGk+CiAgICAgICAgICAgICAgICAgICAgICAgIDxsaT48Yj48YSBocmVmPSJodHRwczovL2dpdGh1Yi5jb20vQkZEWi9QVC1HZW4iIHRhcmdldD0iX2JsYW5rIj5CRkRaL1B0LUdlbjwvYT48L2I+IDoKICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxhIGhyZWY9Imh0dHBzOi8vd3d3LmJmZHouaW5rL3Rvb2xzL3B0Z2VuIgogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldD0iX2JsYW5rIj5odHRwczovL3d3dy5iZmR6Lmluay90b29scy9wdGdlbjwvYT4gLAogICAgICAgICAgICAgICAgICAgICAgICAgICAg5YWs5byA57u05oqk55qEUHQtR2Vu54us56uL5YiG5pSvPC9saT4KICAgICAgICAgICAgICAgICAgICAgICAgPGxpPuixhueTo++8miA8YSBocmVmPSJodHRwczovL2dyZWFzeWZvcmsub3JnL2VuL3NjcmlwdHMvMzg4NzgiIHRhcmdldD0iX2JsYW5rIj7nlLXlvbHkv6Hmga/mn6Xor6LohJrmnKw8L2E+IOaIlgogICAgICAgICAgICAgICAgICAgICAgICAgICAgPGEgaHJlZj0iaHR0cHM6Ly9ncmVhc3lmb3JrLm9yZy9zY3JpcHRzLzMyOTQ4NCIgdGFyZ2V0PSJfYmxhbmsiPuixhueTo+i1hOa6kOS4i+i9veWkp+W4iDwvYT48L2xpPgogICAgICAgICAgICAgICAgICAgICAgICA8bGk+QmFuZ3Vtae+8miBCYW5ndW1pIEluZm8gRXhwb3J0IDxhIGhyZWY9Imh0dHBzOi8vZ2l0LmlvL2ZqbTNsIiB0YXJnZXQ9Il9ibGFuayI+6ISa5pysPC9hPu+8jAogICAgICAgICAgICAgICAgICAgICAgICAgICAgPGEgaHJlZj0iaHR0cHM6Ly9iZ20udHYvZGV2L2FwcC8xMDMiIHRhcmdldD0iX2JsYW5rIj7lupTnlKjlubPlj7A8L2E+PC9saT4KICAgICAgICAgICAgICAgICAgICA8L3VsPgogICAgICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSdoaWRkZW4nPjxzcGFuIGlkPSJidXN1YW56aV9jb250YWluZXJfc2l0ZV9wdiI+5pys56uZ5oC76K6/6Zeu6YePPHNwYW4KICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlkPSJidXN1YW56aV92YWx1ZV9zaXRlX3B2Ij48L3NwYW4+5qyhPC9zcGFuPjwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKCiAgICA8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS9qcXVlcnlAMS4xMi40L2Rpc3QvanF1ZXJ5Lm1pbi5qcyIgaW50ZWdyaXR5PSJzaGEyNTYtWm9zRWJSTCBpbnRlZ3JpdHk9InNoYTI1Ni1VNVpFZUtmR05PamEwMDdNTUQzWUJJMEEzT1NaT1FiZUc2ejJmMlkwaHU4PSIgY3Jvc3NvcmlnaW49ImFub255bW91cyI+PC9zY3JpcHQ+CiAgICA8c2NyaXB0IHNyYz0iaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS9jbGlwYm9hcmRAMi4wLjAvZGlzdC9jbGlwYm9hcmQubWluLmpzIiBpbnRlZ3JpdHk9InNoYTI1Ni1tZUYySEpKMlRjcnV3ejN6NFhjeFlEUk14S3ByamRydUJIYzNJbm1peENRPSIgY3Jvc3NvcmlnaW49ImFub255bW91cyI+PC9zY3JpcHQ+CiAgICA8c2NyaXB0IGFzeW5jIHNyYz0iLy9idXN1YW56aS5pYnJ1Y2UuaW5mby9idXN1YW56aS8yLjMvYnVzdWFuemkucHVyZS5taW5pLmpzIj48L3NjcmlwdD4KICAgIDxzY3JpcHQ+ICAgLy8g6ISa5pys5p+l6K+i55u45YWzCiAgICAgICAgZnVuY3Rpb24ganNvbnAodXJsLCBhcmcsIGZuKSB7CiAgICAgICAgICAgIGxldCBzcnB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2NyaXB0Jyk7CiAgICAgICAgICAgIGxldCBmdW5OYW1lID0gJ2Z1bl8nICsgTWF0aC5yYW5kb20oKS50b1N0cmluZygpLnN1YnN0cigzKTsKCiAgICAgICAgICAgIGxldCBxdWVyeVN0cmluZyA9ICcnOwogICAgICAgICAgICBmb3IgKGxldCBrZXkgaW4gYXJnKSB7CiAgICAgICAgICAgICAgICBxdWVyeVN0cmluZyArPSBrZXkgKyAnPScgKyBhcmdba2V5XSArICcmJwogICAgICAgICAgICB9CiAgICAgICAgICAgIHVybCArPSAnPycgKyBxdWVyeVN0cmluZyArICdjYWxsYmFjaz0nICsgZnVuTmFtZTsKCiAgICAgICAgICAgIHdpbmRvd1tmdW5OYW1lXSA9IGZuOwogICAgICAgICAgICBzcnB0LnNyYyA9IHVybDsKICAgICAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChzcnB0KTsKICAgICAgICB9CgogICAgICAgIGNvbnN0IGRvdWJhbkVudEFwaUtleXMgPSBbCiAgICAgICAgICAgICIwZGFkNTUxZWMwZjg0ZWQwMjkwN2ZmNWM0MmU4ZWM3MCIsCiAgICAgICAgICAgICIwMjY0NmQzZmI2OWE1MmZmMDcyZDQ3YmYyM2NlZjhmZCIsCiAgICAgICAgICAgICIwN2M3ODc4MmRiMDBhMTIxMTc1Njk2ODg5MTAxZTM2MyIKICAgICAgICBdOwoKICAgICAgICBmdW5jdGlvbiBnZXREb3ViYW5FbnRBcGlLZXkoKSB7ICAvLyDpmo/mnLrojrflj5bkuIDkuKprZXkKICAgICAgICAgICAgcmV0dXJuIGRvdWJhbkVudEFwaUtleXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogZG91YmFuRW50QXBpS2V5cy5sZW5ndGgpXTsKICAgICAgICB9CgogICAgICAgICQoZnVuY3Rpb24gKCkgewogICAgICAgICAgICBsZXQgcXVlcnlfYnRuID0gJCgiI3F1ZXJ5X2J0biIpOwogICAgICAgICAgICBsZXQgZ2VuX2hlbHAgPSAkKCIjZ2VuX2hlbHAiKTsKICAgICAgICAgICAgbGV0IGdlbl9vdXQgPSAkKCIjZ2VuX291dCIpOwogICAgICAgICAgICBsZXQgb3V0X3RleHRhcmVhID0gJCgiI21vdmllX2luZm8iKTsKICAgICAgICAgICAgbGV0IGlucHV0X2J0biA9ICQoIiNpbnB1dF92YWx1ZSIpOwogICAgICAgICAgICBsZXQgYXBpX3NlbGVjdCA9ICQoJyNhcGlfc2VsZWN0Jyk7CgogICAgICAgICAgICBxdWVyeV9idG4uZGlzYWJsZSA9IGZ1bmN0aW9uICgpIHsKICAgICAgICAgICAgICAgIHF1ZXJ5X2J0bi5hdHRyKCJkaXNhYmxlZCIsIHRydWUpOwogICAgICAgICAgICAgICAgcXVlcnlfYnRuLmh0bWwoIuafpeivouS4rSIpOwogICAgICAgICAgICB9OwoKICAgICAgICAgICAgcXVlcnlfYnRuLmVuYWJsZSA9IGZ1bmN0aW9uICgpIHsKICAgICAgICAgICAgICAgIHF1ZXJ5X2J0bi5yZW1vdmVBdHRyKCJkaXNhYmxlZCIpOwogICAgICAgICAgICAgICAgcXVlcnlfYnRuLmh0bWwoIuafpeivoiIpOwogICAgICAgICAgICB9OwoKICAgICAgICAgICAgaW5wdXRfYnRuLm9uKCdpbnB1dCBjaGFuZ2UnLCBmdW5jdGlvbiAoKSB7CiAgICAgICAgICAgICAgICBpZiAoaW5wdXRfYnRuLnZhbCgpLm1hdGNoKC9eaHR0cC8pKSB7CiAgICAgICAgICAgICAgICAgICAgJCgnI2FwaV9zZWxlY3RfZGl2OmhpZGRlbicpLnNob3coKTsKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgICAgIGlmIChpbnB1dF9idG4udmFsKCkubWF0Y2goL2ltZGIvKSkgewogICAgICAgICAgICAgICAgICAgICQoJyNmb3JjZV9kb3ViYW5fZGl2Jykuc2hvdygpOwogICAgICAgICAgICAgICAgfSBlbHNlIHsKICAgICAgICAgICAgICAgICAgICAkKCcjZm9yY2VfZG91YmFuX2RpdicpLmhpZGUoKTsKICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgfSk7CgogICAgICAgICAgICBxdWVyeV9idG4uY2xpY2soZnVuY3Rpb24gKCkgewogICAgICAgICAgICAgICAgZ2VuX2hlbHAuaGlkZSgpOwogICAgICAgICAgICAgICAgZ2VuX291dC5zaG93KCk7CiAgICAgICAgICAgICAgICBsZXQgaW5wdXRfdmFsdWUgPSBpbnB1dF9idG4udmFsKCk7CiAgICAgICAgICAgICAgICBpZiAoaW5wdXRfdmFsdWUubGVuZ3RoID09PSAwKSB7CiAgICAgICAgICAgICAgICAgICAgYWxlcnQoIuepuuWtl+espu+8jOivt+ajgOafpei+k+WFpSIpOwogICAgICAgICAgICAgICAgfSBlbHNlIGlmICgvXmh0dHAvLnRlc3QoaW5wdXRfdmFsdWUpKSB7CiAgICAgICAgICAgICAgICAgICAgcXVlcnlfYnRuLmRpc2FibGUoKTsKCiAgICAgICAgICAgICAgICAgICAgbGV0IHBhcmFtID0gewogICAgICAgICAgICAgICAgICAgICAgICB1cmw6IGlucHV0X3ZhbHVlCiAgICAgICAgICAgICAgICAgICAgfTsKICAgICAgICAgICAgICAgICAgICBpZiAoaW5wdXRfdmFsdWUubWF0Y2goL2ltZGIvKSAmJiAkKCcjZm9yY2VfZG91YmFuJykucHJvcCgnY2hlY2tlZCcpKSB7CiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBzaWQgPSBpbnB1dF92YWx1ZS5tYXRjaCgvdHRcZCsvKVswXTsKICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW0gPSB7CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaXRlOiAnZG91YmFuJywKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNpZDogc2lkCiAgICAgICAgICAgICAgICAgICAgICAgIH0KICAgICAgICAgICAgICAgICAgICB9CgogICAgICAgICAgICAgICAgICAgICQuZ2V0SlNPTignLycsIHBhcmFtKS5zdWNjZXNzKGZ1bmN0aW9uIChkYXRhKSB7CiAgICAgICAgICAgICAgICAgICAgICAgIG91dF90ZXh0YXJlYS52YWwoZGF0YVsic3VjY2VzcyJdID09PSBmYWxzZSA/IGRhdGFbImVycm9yIl0gOiBkYXRhWyJmb3JtYXQiXSk7CiAgICAgICAgICAgICAgICAgICAgfSkuZmFpbChmdW5jdGlvbiAoanFYSFIpIHsKICAgICAgICAgICAgICAgICAgICAgICAgYWxlcnQoanFYSFIuc3RhdHVzID09PSA0MjkgPyAnTWV0IFJhdGUgTGltaXQsIFJldHJ5IGxhdGVyficgOiAiRXJyb3Igb2NjdXJlZCEiKTsKICAgICAgICAgICAgICAgICAgICB9KS5jb21wbGV0ZShmdW5jdGlvbiAoKSB7CiAgICAgICAgICAgICAgICAgICAgICAgIHF1ZXJ5X2J0bi5lbmFibGUoKTsKICAgICAgICAgICAgICAgICAgICB9KTsKICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAvLyBTZWFyY2ggZnJvbSBEb3ViYW4KICAgICAgICAgICAgICAgICAgICBnZW5faGVscC5zaG93KCk7CiAgICAgICAgICAgICAgICAgICAgZ2VuX291dC5oaWRlKCk7CiAgICAgICAgICAgICAgICAgICAganNvbnAoImh0dHBzOi8vYXBpLmRvdWJhbi5jb20vdjIvbW92aWUvc2VhcmNoIiwgewogICAgICAgICAgICAgICAgICAgICAgICBxOiBpbnB1dF92YWx1ZSwKICAgICAgICAgICAgICAgICAgICAgICAgYXBpa2V5OiBnZXREb3ViYW5FbnRBcGlLZXkoKQogICAgICAgICAgICAgICAgICAgIH0sIGZ1bmN0aW9uIChyZXNqKSB7CiAgICAgICAgICAgICAgICAgICAgICAgIGdlbl9oZWxwLmh0bWwocmVzai5zdWJqZWN0cy5yZWR1Y2UoKGFjY3VtdWxhdG9yLCBjdXJyZW50VmFsdWUpID0+IHsKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBhY2N1bXVsYXRvciArPSBgPHRyPjx0ZD4ke2N1cnJlbnRWYWx1ZS55ZWFyfTwvdGQ+PHRkPiR7Y3VycmVudFZhbHVlLnN1YnR5cGV9PC90ZD48dGQ+JHtjdXJyZW50VmFsdWUudGl0bGV9PC90ZD48dGQ+PGEgaHJlZj0nJHtjdXJyZW50VmFsdWUuYWx0fScgdGFyZ2V0PSdfYmxhbmsnPiR7Y3VycmVudFZhbHVlLmFsdH08L2E+PC90ZD48dGQ+PGEgaHJlZj0namF2YXNjcmlwdDp2b2lkKDApOycgY2xhc3M9Imdlbi1zZWFyY2gtY2hvb3NlIiBkYXRhLXVybD0iJHtjdXJyZW50VmFsdWUuYWx0fSI+6YCJ5oupPC9hPjwvdGQ+PC90cj5gOwogICAgICAgICAgICAgICAgICAgICAgICB9LCAiPHRhYmxlIGlkPSdnZW5faGVscF90YWJsZScgY2xhc3M9J3RhYmxlIHRhYmxlLXN0cmlwZWQgdGFibGUtaG92ZXInPjx0aGVhZD48dHI+PHRoPuW5tOS7ozwvdGg+PHRoPuexu+WIqzwvdGg+PHRoPuagh+mimDwvdGg+PHRoPuixhueTo+mTvuaOpTwvdGg+PHRoPuihjOS4ujwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4iKSk7CiAgICAgICAgICAgICAgICAgICAgICAgICQoImEuZ2VuLXNlYXJjaC1jaG9vc2UiKS5jbGljayhmdW5jdGlvbiAoKSB7CiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnID0gJCh0aGlzKTsKICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0X2J0bi52YWwodGFnLmF0dHIoImRhdGEtdXJsIikpOwogICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnlfYnRuLmNsaWNrKCk7CiAgICAgICAgICAgICAgICAgICAgICAgIH0pOwogICAgICAgICAgICAgICAgICAgIH0pOwogICAgICAgICAgICAgICAgfQogICAgICAgICAgICB9KTsKICAgICAgICB9KTsKICAgIDwvc2NyaXB0PgogICAgPHNjcmlwdD4gICAvLyDpobXpnaLlpI3liLbnm7jlhbMKICAgICAgICBuZXcgQ2xpcGJvYXJkSlMoJy5idG4tY2xpcGJvYXJkJyk7CiAgICA8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+'), {
    status: 200,
    headers: {
      "Content-Type": "text/html"
    }
  });
}
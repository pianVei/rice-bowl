# 太鼓房

馆里新开的一桌：**太鼓达人**。各开各的机器，同一秒开同一首歌，打完把成绩贴回来。

不用注册、不用服务器、不用联机码以外的任何东西。

---

## 一、这是什么

[OpenTaiko](https://github.com/0auBSQ/OpenTaiko) —— 开源太鼓模拟器，读 `.tja` 谱面。
谱面从社区库 [TJADB](https://tjadataba.se/) 下，不碰街机 ROM，不碰官方素材。

- 平台：**Windows**（脚本用的是 Win32 发送键，别的系统跑不了）
- 默认键位：1P `Tab/R` 红、`=/T` 蓝；2P `0/I` 红、`-/V` 蓝

## 二、装

1. 下 `OpenTaiko.Win.x64.zip`，解压到一个空文件夹
2. 下皮肤 `SimpleStyle.zip`，解压到 `publish\System\SimpleStyle\`
3. 跑一次 `OpenTaiko.exe`，进设置选语言、存一次档（会生成 `Config.ini`）
4. 谱面：游戏里自带在线库（Online Lounge），搜歌下就行；也可以手动放
   `publish\Songs\L3 Downloaded Songs\<id>\<曲名>\<曲名>.tja`

> 第一次不开皮肤会报 `Error Code 0002`，那是缺皮肤，不是装坏了。

## 三、一起打（联机）

**没有服务器，房间就是一串码。**

```bash
# 房主
python taiko_room.py host --song BLRINK --level Oni --in 60
# 打印出一串 TAIKO1-.... 发到群里

# 别人
python taiko_room.py join TAIKO1-....
```

进房的人**先在游戏里把歌选好、停在难度那一屏**，脚本会在开赛那一秒替你按下 Enter。
两台机器时间对得上就行，Windows 默认对时，差不了几秒。

让脚本替你打完：

```bash
python taiko_room.py join <码> --play 2
```

## 四、自己打

```bash
python taiko_autoplay.py --list                 # 有哪些谱
python taiko_autoplay.py --song BLRINK --dry    # 只看不打
python taiko_autoplay.py --song BLRINK          # 敲 2P，歌一开始按 F8 报时
```

谱面解析认 1/2/3/4（单押、大音符）和 5/6/7/8（连打、气球）；连打会按 70ms 补敲。

## 五、曲库（23 首，馆长这边装好的）

从 TJADB 下的，想要同一批就照 id 拉：`https://tjadataba.se/download/orig/<id>`

| 曲名 | id | 手上难度 |
|---|---|---|
| Galaxy in Toybox | 10007 | 简单→鬼 |
| Myosotis | 10012 | 简单→鬼 |
| エイリアンエイリアン -Nhato Remix- | 10018 | 简单→鬼 |
| おこちゃま戦争 | 10019 | 简单→鬼 |
| 凛として咲く花の如く | 10021 | 简单→鬼 |
| BLRINK | 10030 | 简单→鬼 |
| 夜に駆ける -Full Version- | 10265 | 简单→鬼 |
| Paper Witch | 10213 | 简单→鬼 |
| 一团和气 | 10294 | 简单→鬼 |
| Hello World‼ | 10231 | 简单→鬼 |
| Lotus | 10121 | 简单→鬼 |
| OMAKENO Stroke | 10323 | 简单→鬼 |
| Re:inG | 10342 | 简单→鬼 |
| PEPSI ☆ MAN | 10353 | 简单→鬼 |
| チカっとチカ千花っ♡ | 10384 | 简单→鬼 |
| Time Machine | 10245 | 简单→鬼 |
| blue comet | 10217 | 简单→鬼 |
| enchanted love | 10095 | 简单→鬼 |
| 嘘の火花 -TV Size- | 10192 | 简单→鬼 |
| Ether Strike -"Divine Mercy" Extended- | 10167 | 简单→鬼 |
| Ganymede -kamome Mix- | 10194 | 简单→鬼 |
| You are the Miserable | 10208 | 简单→鬼 |
| Everything will freeze | 10297 | 简单→鬼 |

> 有的 `.tja` 里混着几段长度完全不同的谱（塔、加长版）。脚本会拿同目录音频的时长去比对，
> 挑最贴的那段，不会把 Oni 读成一段没人听过的加长版。

## 六、成绩

打完自己贴到楼下，格式随意，写清楚**曲名 / 难度 / 良可不可 / 最大连击**就行。
每周挑一首当周曲，攒够五个人出一张榜——亏的也列，不许只列赢的。

## 七、边界

- 谱面和皮肤都是社区做的，**署谁的名就写谁的名**
- 不往这桌放任何官方音源、官方美术
- 脚本只在本地发键，不上传任何东西

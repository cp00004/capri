package com.capri.app;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// One word list for every surface (PC guard, phone guard, gallery scan).
// Short generic words use word boundaries so "sex" closes a sex page but not
// "Sussex"; brand fragments are matched as plain substrings because they show
// up inside domains, tab titles and share links.
final class NnnRules {
	private NnnRules() {}

	private static final String[] WORDS = {
		"porn", "pornos", "porno", "pornography", "pornographic", "pornstar", "pornstars",
		"hentai", "hentais", "hentaihaven", "ecchi", "ahegao", "doujin", "doujinshi", "eroge",
		"anime", "yaoi", "yuri", "loli", "shota",
		"sex", "sexy", "sexual", "sexting", "sexcam", "sextape", "sexvideo", "sexvideos",
		"xxx", "xxxx", "nsfw", "nude", "nudes", "nudity", "naked", "lewd",
		"adult", "adults", "milf", "gilf", "dilf", "bdsm", "fetish", "orgy", "threesome", "foursome",
		"gangbang", "creampie", "cumshot", "blowjob", "handjob", "anal", "pussy", "vagina", "penis",
		"nipple", "nipples", "boobs", "tits", "titties", "horny", "masturbation", "masturbate",
		"orgasm", "squirting", "camgirl", "camgirls", "camshow", "onlyfans", "fansly", "rule34",
		"nhentai", "e621", "gelbooru", "danbooru", "hanime", "sankaku", "erome", "xhamster",
		"pornhub", "xvideos", "xnxx", "redtube", "youporn", "spankbang", "chaturbate", "stripchat",
		"livejasmin", "bongacams", "camsoda", "jerkmate", "manyvids", "brazzers", "bangbros",
		"realitykings", "mofos", "motherless", "xozilla", "beeg", "hqporner", "thumbzilla",
		"porntrex", "xxnx", "sexvid", "xkeezmovies", "pornmd", "fap", "fapping", "fapello",
		"coomer", "incest", "stepmom", "stepsis", "stepsister", "stepbro", "bestiality", "zoophilia",
	};

	// Plain substrings: these only appear on adult sites, so no boundaries needed.
	private static final String[] BRANDS = {
		"pornhub", "xvideos", "xnxx", "xhamster", "redtube", "youporn", "spankbang", "tube8",
		"eporner", "beeg.com", "txxx", "javhd", "missav", "supjav", "javbus", "javgg", "7mmtv",
		"vjav", "hanime.tv", "hentaihaven", "e-hentai", "exhentai", "hitomi.la", "rule34",
		"gelbooru", "danbooru", "konachan", "yande.re", "sankakucomplex", "onlyfans", "fansly",
		"justfor.fans", "manyvids", "fanvue", "chaturbate", "stripchat", "livejasmin", "bongacams",
		"camsoda", "cam4.com", "myfreecams", "flirtymania", "xlovecam", "cherry.tv", "jerkmate",
		"dirtyroulette", "brazzers", "bangbros", "realitykings", "mofos", "naughtyamerica",
		"digitalplayground", "private.com", "babes.com", "twistys", "adultfriendfinder", "fetlife",
		"kink.com", "literotica", "lushstories", "sex.com", "sexvid", "sexstories", "porntrex",
		"hqporner", "thumbzilla", "motherless", "efukt", "erome.com", "e621.net", "fapello",
		"fapdu", "faphouse", "fap18", "fapflix", "camwhores", "alotporn", "anyporn", "anysex",
		"3movs", "4tube", "empflix", "gotporn", "drtuber", "hellporno", "hdsex", "hdzog", "hclips",
		"hdtube", "iceporn", "definebabe", "damplips", "cliphunter", "bobs-tube", "bigtits",
		"ass4all", "amateur8", "analdin", "anon-v", "badjojo", "bonporn", "camhub", "ceporn",
		"cumlouder", "desiporn", "extremesex", "fantasti.cc", "fux.com", "gatsporn", "gayporn",
		"hentaipros", "hentaifox", "hentai2read", "javwhores", "javhihi", "sxyprn", "tnaflix",
		"upornia", "porntube", "pornone", "porn300", "pornid", "pornhd", "porngo", "porndig",
		"pornwhite", "pornhat", "pornsocket", "pornolab", "youjizz", "yespornplease", "porn.com",
		"pornoxo", "pornhits", "pornburst", "pornzog", "porn4days", "pornflip", "pornobae",
		"xxxtube", "xxxbp", "xporn", "xporno", "xsex", "xsexporn", "yxosh", "zbporn", "24porn",
		"9taxi", "ah-me", "yuvutu", "xozilla", "xvidzz", "sunporno", "porntop", "porntopic",
		"pornrage", "pornvids", "noodlemagazine", "zootube365", "xvideo", "redtube.com",
		"onlyfans.com", "nhentai.net", "fapello.com", "cam4", "livejasmin.com", "stripchat.com",
	};

	// .porn, .sex, .xxx and friends leave no doubt about the page.
	// Outside a browser the same words show up in ordinary chats ("we watched
	// anime"), so apps only answer to the unambiguous ones. A browser gets the
	// full list because there the page address is the signal.
	private static final String[] STRICT = {
		"porn", "pornos", "porno", "pornography", "pornographic", "pornstar", "pornstars",
		"hentai", "hentais", "hentaihaven", "nhentai", "rule34", "e621", "hanime",
		"nsfw", "onlyfans", "fansly", "chaturbate", "stripchat", "livejasmin", "bongacams",
		"camsoda", "jerkmate", "manyvids", "brazzers", "bangbros", "realitykings", "milf",
		"nudes", "xxx", "xxxx", "xvideos", "xnxx", "xhamster", "redtube", "youporn",
		"spankbang", "porntrex", "hqporner", "motherless", "xozilla", "beeg", "thumbzilla",
		"pornhub", "masturbation", "camgirl", "camshow", "camgirls", "erotica", "eroge",
		"ahegao", "doujin", "doujinshi", "ecchi", "bestiality", "zoophilia", "incest",
	};

	private static final Pattern ADULT_TLD = Pattern.compile("\\.(?:porn|sex|xxx|adult|nude|sexy)\\b", Pattern.CASE_INSENSITIVE);

	private static final Pattern WORD_PATTERN = buildWords(WORDS);
	private static final Pattern STRICT_PATTERN = buildWords(STRICT);

	private static Pattern buildWords(String[] words) {
		StringBuilder sb = new StringBuilder("\\b(?:");
		for (int i = 0; i < words.length; i++) {
			if (i > 0) sb.append('|');
			sb.append(Pattern.quote(words[i]));
		}
		return Pattern.compile(sb.append(")\\b"), Pattern.CASE_INSENSITIVE);
	}

	static String firstHit(String haystack) {
		return match(WORD_PATTERN, haystack);
	}

	static String strictHit(String haystack) {
		return match(STRICT_PATTERN, haystack);
	}

	private static String match(Pattern words, String haystack) {
		if (haystack == null || haystack.isEmpty()) return "";
		Matcher word = words.matcher(haystack);
		if (word.find()) return word.group();
		String low = haystack.toLowerCase(Locale.US);
		for (String brand : BRANDS) {
			if (low.contains(brand)) return brand;
		}
		Matcher tld = ADULT_TLD.matcher(low);
		if (tld.find()) return tld.group();
		return "";
	}
}

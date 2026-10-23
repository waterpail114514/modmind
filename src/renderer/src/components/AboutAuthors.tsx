import waterpailAvatar from '../assets/authors/waterpail.webp'
import lemonAvatar from '../assets/authors/lemon.webp'
import anonymousAvatar from '../assets/authors/anonymous.webp'
import xiaobowenAvatar from '../assets/authors/xiaobowen.webp'
import hydrargyrumAvatar from '../assets/authors/hydrargyrum.webp'
import yecairenAvatar from '../assets/authors/yecairen.webp'
import sq0Avatar from '../assets/authors/sq0.webp'
import lihuiAvatar from '../assets/authors/lihui.webp'
import callAvatar from '../assets/authors/c-all.webp'
import modmindWordmark from '../assets/logo-wordmark.svg'
import modmindWordmarkDark from '../assets/logo-wordmark-dark.svg'
import users from '../assets/about-users-1.4.12.json'
import './about-authors.css'

const groups = [
  {
    title: '制作人',
    people: [
      { name: '以太工作室·水桶', role: '客户端制作人', avatar: waterpailAvatar },
      { name: '以太工作室·柠檬', role: '网页制作人', avatar: lemonAvatar }
    ]
  },
  {
    title: '社区贡献者',
    people: [
      { name: 'XiaoBowen', avatar: xiaobowenAvatar },
      { name: '佚名即无名', avatar: anonymousAvatar },
      { name: 'SQ0', avatar: sq0Avatar },
      { name: '理惠', avatar: lihuiAvatar },
      { name: 'C.all', avatar: callAvatar },
      { name: 'Hydrargyrum', avatar: hydrargyrumAvatar },
      { name: '野菜仁', avatar: yecairenAvatar }
    ]
  }
]

const userGroups = [
  { names: users.returning, size: 'returning' },
  { names: users.new, size: 'new' },
  { names: users.unpaid, size: 'unpaid' }
]

export default function AboutAuthors(): React.JSX.Element {
  return <div className="about-authors">
    {groups.map(group => <div className="about-authors-group" key={group.title}>
      <h3>{group.title}</h3>
      <div className="about-authors-people">
        {group.people.map(person => <div className="about-authors-person" key={person.name}>
          <img src={person.avatar} alt="" width="48" height="48" />
          <div>
            <strong>{person.name}</strong>
            {'role' in person && <span>{person.role}</span>}
          </div>
        </div>)}
      </div>
    </div>)}
    <div className="about-users">
      <h3>以及：</h3>
      {userGroups.map(group => <div className={`about-users-group ${group.size}`} key={group.size}>
        <div className="about-users-names">
          {group.names.map((name, index) => <span key={index}>{name}</span>)}
        </div>
      </div>)}
      <p className="about-users-note">（仅含 1.4.12 发布前用户；后续注册用户将在新版本加入）</p>
      <div className="about-authors-logo">
        <img className="about-authors-logo-light" src={modmindWordmark} alt="ModMind" />
        <img className="about-authors-logo-dark" src={modmindWordmarkDark} alt="ModMind" />
      </div>
    </div>
  </div>
}

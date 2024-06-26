import { arrayRemove, arrayUnion, doc, updateDoc } from "firebase/firestore";
import { useChatStore } from "../../lib/chatStore";
import { auth, db } from "../../lib/firebase";
import { useUserStore } from "../../lib/userStore";
import "./detail.css";

const Detail = () => {
  const { currentUser } = useUserStore();
  const { chatId, user, isCurrentUserBlocked, isReceiverBlocked, changeBlock } =
    useChatStore();

  const handleBlock = async () => {
    if (!user) return;
    const userDocRef = doc(db, "users", currentUser.id);
    try {
      await updateDoc(userDocRef, {
        blocked: isReceiverBlocked ? arrayRemove(user.id) : arrayUnion(user.id),
      });
      changeBlock();
    } catch (err) {
      console.log(err);
    }
  };

  return (
    <div className="detail">
      {chatId && (
        <>
          <div className="user">
            <img src={user?.avatar || "./avatar.png"} alt="" />
            <h2>{user?.username}</h2>
            <p>Lorem Ipsum is simply dummy text</p>
          </div>
          <div className="info">
            <div className="option">
              <div className="title">
                <span>Chat Settings</span>
                <img src="./arrowUp.png" alt="" />
              </div>
            </div>
            <div className="option">
              <div className="title">
                <span>Privacy & help</span>
                <img src="./arrowUp.png" alt="" />
              </div>
            </div>
            <div className="option">
              <div className="title">
                <span>Shared phots</span>
                <img src="./arrowDown.png" alt="" />
              </div>
              <div className="photos">
                <div className="photoItem">
                  <div className="photoDetail">
                    <img
                      src="https://images.pexels.com/photos/807598/pexels-photo-807598.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2"
                      alt=""
                    />
                    <span>photot_2024_1.png</span>
                  </div>
                  <img src="download.png" alt="" className="icon" />
                </div>
                <div className="photoItem">
                  <div className="photoDetail">
                    <img
                      src="https://images.pexels.com/photos/807598/pexels-photo-807598.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2"
                      alt=""
                    />
                    <span>photot_2024_1.png</span>
                  </div>
                  <img src="download.png" alt="" className="icon" />
                </div>
                <div className="photoItem">
                  <div className="photoDetail">
                    <img
                      src="https://images.pexels.com/photos/807598/pexels-photo-807598.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2"
                      alt=""
                    />
                    <span>photot_2024_1.png</span>
                  </div>
                  <img src="download.png" alt="" className="icon" />
                </div>
              </div>
            </div>
            <div className="option">
              <div className="title">
                <span>Shared Files</span>
                <img src="./arrowUp.png" alt="" />
              </div>
            </div>
            <button onClick={handleBlock}>
              {isCurrentUserBlocked
                ? "You are blocked"
                : isReceiverBlocked
                ? "User blocked!, Click to unblock"
                : "Block User"}
            </button>
            <button className="logout" onClick={() => auth.signOut()}>
              Logout
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default Detail;
